#!/usr/bin/env node
/*
 * Pure-logic regression check for SshSessionService (T-380, Schritt 3/8 SSH).
 * Mirrors the spec's acceptance set for the operation pump:
 *   - connect() TOFU paths (not-accepted, mismatch)
 *   - credential_missing
 *   - exec happy-path with audit
 *   - exec stdout truncation
 *   - exec timeout → SIGTERM → SIGKILL
 *   - exec cwd shell-escape
 *   - sftpUpload / sftpDownload (with truncation)
 *   - listFiles with maxEntries cap
 *   - concurrency semaphore wait + timeout
 *
 * Run with `npm run check:ssh-session` from backend/ after `npm run build`.
 * No Jest, no real Mongo. Mongoose Types come from the compiled module so
 * the audit-userId ObjectId guard behaves exactly like production.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { SshSessionService } = loadCompiled('ssh/ssh-session.service.js');
const mongoose = loadCompiled('../node_modules/mongoose/index.js');
const { Types } = mongoose;

let failures = 0;
let total = 0;
function check(label, fn) {
  total += 1;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`✓ ${label}`))
    .catch((err) => {
      failures += 1;
      console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
    });
}

// ---------------------------------------------------------------------------
// Connection builders
// ---------------------------------------------------------------------------
function makeKeyConnection(overrides = {}) {
  return {
    _id: new Types.ObjectId(),
    label: 'web-01',
    slug: 'web-01',
    customerId: new Types.ObjectId(),
    projectId: undefined,
    host: 'host.example',
    port: 22,
    username: 'deploy',
    authMethod: 'key',
    privateKeySecretId: new Types.ObjectId(),
    passphraseSecretId: undefined,
    passwordSecretId: undefined,
    tags: [],
    knownHostFingerprint: undefined,
    lastConnectedAt: undefined,
    lastConnectError: undefined,
    notifyOnAuthFailure: false,
    ...overrides,
  };
}

// Canonical SHA-256 form for the fake 32-byte hash the FakeClient always
// returns (matches SshTestService's fake too).
const FAKE_FINGERPRINT =
  '01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:' +
  '01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------
function makeSshServiceStub({ connection } = {}) {
  const calls = { recordConnectError: [], recordConnectSuccess: [] };
  return {
    calls,
    async findById(id) {
      if (!connection || String(connection._id) !== String(id)) {
        const err = new Error('SshConnection not found');
        err.status = 404;
        throw err;
      }
      return connection;
    },
    async recordConnectError(id, msg) {
      calls.recordConnectError.push({ id: String(id), msg });
    },
    async recordConnectSuccess(id) {
      calls.recordConnectSuccess.push({ id: String(id) });
    },
  };
}

function makeSecretsServiceStub({ failOn = null } = {}) {
  return {
    async findById(id) {
      if (failOn === String(id)) {
        const err = new Error('Secret not found');
        err.status = 404;
        throw err;
      }
      return { _id: String(id), key: 'k', type: 'ssh_key', value: `plain:${id}` };
    },
  };
}

function makeAuditModelStub() {
  const writes = [];
  return {
    _writes: writes,
    async create(doc) {
      writes.push(doc);
      return doc;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake ssh2.Client. Each test builds its own and primes behaviour via the
// `behaviour` arg + per-channel hooks attached after `client.exec()` returns
// its stream. We always drive hostVerifier first (mirrors real ssh2).
// ---------------------------------------------------------------------------
function makeFakeClient(behaviour = {}) {
  const handlers = {};
  const channelHandlers = {};
  let channel = null;

  function emitChan(event, ...args) {
    const set = channelHandlers[event];
    if (!set) return;
    for (const h of set) h(...args);
  }

  function makeChannel(opts = {}) {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.signal = (sig) => {
      if (behaviour.captureSignals) behaviour.captureSignals.push(sig);
    };
    stream.close = () => {
      stream.emit('close');
    };
    stream.write = () => true;
    stream.end = () => {};
    stream.setWindow = () => {};
    return stream;
  }

  const client = {
    handlers,
    on(event, cb) {
      handlers[event] = cb;
      return client;
    },
    endCalls: 0,
    destroyCalls: 0,
    end() { this.endCalls += 1; },
    destroy() { this.destroyCalls += 1; },
    connect(opts) {
      // Drive hostVerifier first.
      const hash = Buffer.from(
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        'hex',
      );
      const verifier = opts.hostVerifier;
      let accept = false;
      let cbCalled = false;
      const cb = (a) => { cbCalled = true; accept = a; };
      const ret = verifier ? verifier(hash, cb) : true;
      if (!cbCalled && typeof ret === 'boolean') accept = ret;

      if (!accept) {
        // ssh2 fires 'error' when the verifier rejected.
        process.nextTick(() => {
          if (handlers.error) {
            const e = new Error('Host key verification failed');
            e.level = 'protocol';
            handlers.error(e);
          }
        });
        return;
      }

      // Fingerprint accepted → fire ready.
      process.nextTick(() => {
        if (handlers.ready) handlers.ready();
      });
    },
    // exec() spawns a channel and exposes its events via the callback.
    // onChannel runs AFTER the service installed its listeners (i.e. inside
    // a setImmediate following cb), otherwise the synchronous emit races
    // ahead of the listener attach and the test sees an empty stdout.
    exec(command, optsOrCb, maybeCb) {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
      if (behaviour.captureExec) behaviour.captureExec.push({ command });
      const stream = makeChannel();
      channel = stream;
      process.nextTick(() => {
        cb(undefined, stream);
        if (behaviour.onChannel) {
          setImmediate(() => behaviour.onChannel(stream));
        }
      });
      return client;
    },
    shell(window, cb) {
      const stream = makeChannel(window);
      process.nextTick(() => cb(undefined, stream));
      return client;
    },
    sftp(cb) {
      if (behaviour.sftp) {
        process.nextTick(() => cb(undefined, behaviour.sftp));
      } else {
        process.nextTick(() => cb(new Error('no sftp in this fake')));
      }
      return client;
    },
  };
  return client;
}

function makeClientFactory(behaviour) {
  const inst = { _last: null };
  return {
    create: () => {
      const c = makeFakeClient(behaviour);
      inst._last = c;
      return c;
    },
    _inst: inst,
  };
}

// ---------------------------------------------------------------------------
// Fake SFTP wrappers (per test)
// ---------------------------------------------------------------------------
function makeFakeSftp({
  readdirEntries = null,
  writeBehaviour = null,
  readBehaviour = null,
  mkdirCalls = null,
} = {}) {
  return {
    readdir(p, cb) {
      if (readdirEntries) cb(undefined, readdirEntries(p));
      else cb(new Error('readdir not configured'));
    },
    mkdir(p, cbOrAttrs, maybeCb) {
      const cb = typeof cbOrAttrs === 'function' ? cbOrAttrs : maybeCb;
      if (mkdirCalls) mkdirCalls.push(p);
      cb && cb();
    },
    createWriteStream(p, opts) {
      const ws = new EventEmitter();
      ws.write = (chunk, cb) => {
        if (writeBehaviour && writeBehaviour.fail) {
          process.nextTick(() => cb && cb(writeBehaviour.fail));
          return false;
        }
        if (writeBehaviour) writeBehaviour.lastChunk = chunk;
        process.nextTick(() => cb && cb());
        return true;
      };
      ws.end = () => {
        process.nextTick(() => ws.emit('close'));
      };
      return ws;
    },
    createReadStream(p, opts) {
      const rs = new EventEmitter();
      rs.destroy = () => {};
      process.nextTick(() => {
        if (readBehaviour && readBehaviour.chunks) {
          for (const c of readBehaviour.chunks) rs.emit('data', c);
          rs.emit('end');
        } else {
          rs.emit('close');
        }
      });
      return rs;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
(async () => {
  // 1) connect() without knownHostFingerprint → tofu_not_accepted
  await check('connect() throws tofu_not_accepted when knownHostFingerprint is unset', async () => {
    const conn = makeKeyConnection();
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const factory = makeClientFactory();
    const svc = new SshSessionService(sshService, secrets, audit, factory);

    await assert.rejects(() => svc.connect(String(conn._id)), /tofu_not_accepted/);
    assert.equal(sshService.calls.recordConnectError.length, 1);
    assert.match(sshService.calls.recordConnectError[0].msg, /tofu_not_accepted/);
  });

  // 2) connect() with mismatch → host_key_mismatch
  await check('connect() throws host_key_mismatch when stored fingerprint differs', async () => {
    const conn = makeKeyConnection({
      knownHostFingerprint:
        'ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:' +
        'ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff',
    });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const factory = makeClientFactory();
    const svc = new SshSessionService(sshService, secrets, audit, factory);

    await assert.rejects(() => svc.connect(String(conn._id)), /host_key_mismatch/);
    assert.equal(sshService.calls.recordConnectError.length, 1);
    assert.match(sshService.calls.recordConnectError[0].msg, /host_key_mismatch/);
  });

  // 3) connect() with missing privateKeySecret → credential_missing
  await check('connect() throws credential_missing when privateKey secret is gone', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub({ failOn: String(conn.privateKeySecretId) });
    const audit = makeAuditModelStub();
    const factory = makeClientFactory();
    const svc = new SshSessionService(sshService, secrets, audit, factory);

    await assert.rejects(() => svc.connect(String(conn._id)), /credential_missing/);
    assert.equal(sshService.calls.recordConnectError.length, 1);
    assert.match(sshService.calls.recordConnectError[0].msg, /credential_missing/);
  });

  // 4) exec happy-path
  await check('exec() returns stdout/stderr/exitCode and writes a single audit entry', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const factory = makeClientFactory({
      onChannel: (stream) => {
        stream.emit('data', Buffer.from('hello\n'));
        stream.stderr.emit('data', Buffer.from('warn\n'));
        stream.emit('exit', 0);
        stream.emit('close');
      },
    });
    const svc = new SshSessionService(sshService, secrets, audit, factory);

    const userId = new Types.ObjectId().toString();
    const out = await svc.exec(String(conn._id), 'echo hello', { userId });
    assert.equal(out.stdout, 'hello\n');
    assert.equal(out.stderr, 'warn\n');
    assert.equal(out.exitCode, 0);
    assert.equal(out.truncated.stdout, false);
    assert.equal(out.truncated.stderr, false);
    assert.ok(out.durationMs >= 0);

    // Audit written for valid ObjectId userId.
    assert.equal(audit._writes.length, 1);
    assert.equal(audit._writes[0].action, 'exec');
    assert.equal(audit._writes[0].sourceContext, 'mcp');
    assert.equal(audit._writes[0].command, 'echo hello');
    assert.equal(audit._writes[0].exitCode, 0);
  });

  // 5) exec stdout truncation
  await check('exec() truncates stdout at 256 KB and appends a marker', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const factory = makeClientFactory({
      onChannel: (stream) => {
        // 300 KB of stdout in two ~150KB chunks so we exercise the
        // partial-fit branch.
        stream.emit('data', Buffer.alloc(150 * 1024, 65)); // 'A'
        stream.emit('data', Buffer.alloc(150 * 1024, 66)); // 'B'
        stream.emit('exit', 0);
        stream.emit('close');
      },
    });
    const svc = new SshSessionService(sshService, secrets, audit, factory);

    const userId = new Types.ObjectId().toString();
    const out = await svc.exec(String(conn._id), 'spam', { userId });

    assert.equal(out.truncated.stdout, true);
    // 256 KB of real output + the truncation marker tail.
    assert.ok(out.stdout.length > 256 * 1024);
    assert.match(out.stdout, /\[truncated: \d+ bytes more\]$/);
  });

  // 6) exec timeout → SIGTERM
  await check('exec() escalates to SIGTERM after timeoutMs and returns signal=SIGTERM', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const captured = [];
    let timedOutStream = null;
    const factory = makeClientFactory({
      captureSignals: captured,
      onChannel: (stream) => {
        timedOutStream = stream;
        // Channel deliberately never emits exit/close on its own — the
        // timeout path must end the wait.
      },
    });
    const svc = new SshSessionService(sshService, secrets, audit, factory);

    const userId = new Types.ObjectId().toString();
    // Patch global setTimeout so the 5s SIGKILL grace and the 50ms timeout
    // both happen "now". We snapshot the real one so other tests keep
    // working.
    const realSetTimeout = global.setTimeout;
    let armed = 0;
    global.setTimeout = (fn, ms) => {
      armed += 1;
      // Fire immediately so the timeout path runs synchronously across
      // both arming sites (the outer timeout + the SIGKILL grace).
      return realSetTimeout(fn, 0);
    };
    try {
      const out = await svc.exec(String(conn._id), 'sleep 999', { userId, timeoutMs: 50 });
      // At minimum SIGTERM was issued; SIGKILL too because grace=0.
      assert.ok(captured.includes('TERM'), `expected TERM signal, got ${captured.join(',')}`);
      // After the SIGKILL escalation, finalize() ran via the grace timer.
      assert.ok(out.signal === 'SIGKILL' || out.signal === 'SIGTERM');
      // exitCode stays null on signalled finalize.
      assert.equal(out.exitCode, null);
    } finally {
      global.setTimeout = realSetTimeout;
      // Defensive cleanup so a leaked test stream can't pin the loop.
      if (timedOutStream) {
        try { timedOutStream.emit('close'); } catch { /* noop */ }
      }
    }
    assert.ok(armed >= 1);
  });

  // 7) exec with cwd → shell-quoted prefix
  await check('exec() with cwd prefixes the command with cd \'<cwd>\' && and escapes single-quotes', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const capture = [];
    const factory = makeClientFactory({
      captureExec: capture,
      onChannel: (stream) => {
        stream.emit('exit', 0);
        stream.emit('close');
      },
    });
    const svc = new SshSessionService(sshService, secrets, audit, factory);

    const userId = new Types.ObjectId().toString();
    await svc.exec(String(conn._id), 'ls', { userId, cwd: "/tmp/it's a dir" });
    assert.equal(capture.length, 1);
    // Single-quote escape: ' → '\''  →  "/tmp/it'\''s a dir"
    assert.equal(capture[0].command, `cd '/tmp/it'\\''s a dir' && ls`);

    // Audit command stays the unwrapped form (truncated user-facing command).
    assert.equal(audit._writes[0].command, 'ls');
  });

  // 8) sftpUpload happy-path
  await check('sftpUpload() writes the buffer and returns bytesWritten', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const writeBehaviour = {};
    const sftp = makeFakeSftp({ writeBehaviour });
    const factory = makeClientFactory({ sftp });
    const svc = new SshSessionService(sshService, secrets, audit, factory);

    const userId = new Types.ObjectId().toString();
    const out = await svc.sftpUpload(
      String(conn._id),
      '/srv/app/cfg.json',
      Buffer.from('hello world'),
      { userId, mode: 0o600 },
    );
    assert.equal(out.bytesWritten, 11);
    assert.equal(out.remotePath, '/srv/app/cfg.json');
    assert.deepEqual(writeBehaviour.lastChunk, Buffer.from('hello world'));
    assert.equal(audit._writes.length, 1);
    assert.equal(audit._writes[0].action, 'upload');
    assert.equal(audit._writes[0].bytes, 11);
  });

  // 9) sftpDownload truncation
  await check('sftpDownload() stops at maxBytes and sets truncated=true', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const sftp = makeFakeSftp({
      readBehaviour: {
        chunks: [Buffer.alloc(100, 65), Buffer.alloc(100, 66), Buffer.alloc(100, 67)],
      },
    });
    const factory = makeClientFactory({ sftp });
    const svc = new SshSessionService(sshService, secrets, audit, factory);

    const userId = new Types.ObjectId().toString();
    const out = await svc.sftpDownload(
      String(conn._id),
      '/var/log/big.log',
      { userId, maxBytes: 150 },
    );
    assert.equal(out.bytesRead, 150);
    assert.equal(out.truncated, true);
    assert.equal(out.content.length, 150);
    assert.equal(out.content[0], 65); // 'A'
    assert.equal(out.content[149], 66); // 'B' — we cut mid-second-chunk
  });

  // 10) listFiles with maxEntries cap
  await check('listFiles() caps results at maxEntries and sets truncated=true', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const sftp = makeFakeSftp({
      readdirEntries: () => [
        { filename: 'a.txt', attrs: { size: 1, mode: 0o100644, mtime: 1700000000, isDirectory: () => false, isSymbolicLink: () => false } },
        { filename: 'b.txt', attrs: { size: 2, mode: 0o100644, mtime: 1700000000, isDirectory: () => false, isSymbolicLink: () => false } },
        { filename: 'c.txt', attrs: { size: 3, mode: 0o100644, mtime: 1700000000, isDirectory: () => false, isSymbolicLink: () => false } },
        { filename: 'd.txt', attrs: { size: 4, mode: 0o100644, mtime: 1700000000, isDirectory: () => false, isSymbolicLink: () => false } },
        { filename: 'e.txt', attrs: { size: 5, mode: 0o100644, mtime: 1700000000, isDirectory: () => false, isSymbolicLink: () => false } },
      ],
    });
    const factory = makeClientFactory({ sftp });
    const svc = new SshSessionService(sshService, secrets, audit, factory);

    const userId = new Types.ObjectId().toString();
    const out = await svc.listFiles(String(conn._id), '/srv', { userId, maxEntries: 3 });
    assert.equal(out.entries.length, 3);
    assert.equal(out.truncated, true);
    assert.equal(out.entries[0].name, 'a.txt');
    assert.equal(out.entries[0].path, '/srv/a.txt');
    assert.equal(out.entries[0].type, 'file');
    assert.ok(out.entries[0].mtime instanceof Date);
  });

  // 11) Concurrency semaphore: 6th wait → timeout → concurrency_limit_exceeded
  await check('acquireSlot() rejects with concurrency_limit_exceeded when queue wait times out', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const factory = makeClientFactory();
    const svc = new SshSessionService(sshService, secrets, audit, factory);

    // Saturate the in-process semaphore directly via the private methods.
    // The spec mandates max 5 concurrent slots per connection.
    for (let i = 0; i < 5; i += 1) await svc['acquireSlot'](String(conn._id));

    // 6th waiter needs the queue path; squash the 30s wait to ~0.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => realSetTimeout(fn, 0);
    try {
      await assert.rejects(
        () => svc['acquireSlot'](String(conn._id)),
        /concurrency_limit_exceeded/,
      );
    } finally {
      global.setTimeout = realSetTimeout;
    }

    // Release everyone we acquired so the state map doesn't leak across
    // assertions.
    for (let i = 0; i < 5; i += 1) svc['releaseSlot'](String(conn._id));
  });

  // 12) Concurrency: 6th caller actually WAITS until a slot frees up.
  // (Not in the spec list but covers the happy-queue path so we don't ship
  // a semaphore that only handles the timeout branch.)
  await check('acquireSlot() resolves the queued waiter when an earlier op releases', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const factory = makeClientFactory();
    const svc = new SshSessionService(sshService, secrets, audit, factory);

    for (let i = 0; i < 5; i += 1) await svc['acquireSlot'](String(conn._id));
    let resolved = false;
    const sixth = svc['acquireSlot'](String(conn._id)).then(() => { resolved = true; });

    // 6th should still be pending immediately after enqueue.
    await new Promise((r) => setImmediate(r));
    assert.equal(resolved, false);

    // Free a slot — the queued waiter must resolve on the next tick.
    svc['releaseSlot'](String(conn._id));
    await sixth;
    assert.equal(resolved, true);

    // Clean up the remaining 5 active slots.
    for (let i = 0; i < 5; i += 1) svc['releaseSlot'](String(conn._id));
  });

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log('');
  console.log(`SSH session unit checks: ${total - failures}/${total} passed`);
  if (failures > 0) process.exit(1);
})();
