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

/**
 * Minimal NotificationsService stub. Records `create()` calls so tests can
 * assert auth-failure pushes (T-385) without needing the real service /
 * push-subscription plumbing.
 */
function makeNotificationsStub() {
  const calls = [];
  return {
    calls,
    async create(title, body, url, category) {
      const entry = { title, body, url, category, _id: `notif-${calls.length}` };
      calls.push(entry);
      return entry;
    },
  };
}

// Settings stub for the upload-limit resolver. Default returns null for every
// key, so resolveUploadLimit() falls back to the 10 MB default and the legacy
// upload-cap assertions below still hold. Pass `{ maxUploadBytes }` to simulate
// a configured global limit.
function makeSettingsStub({ maxUploadBytes = null } = {}) {
  return {
    async get(key) {
      if (key === 'ssh.maxUploadBytes') {
        return maxUploadBytes === null ? null : String(maxUploadBytes);
      }
      return null;
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

  function makeChannel(_opts = {}) {
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
      if (cb) cb();
    },
    createWriteStream(_p, _opts) {
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
    createReadStream(_p, _opts) {
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
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

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
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

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
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

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
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

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
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

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
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

    const userId = new Types.ObjectId().toString();
    // Patch global setTimeout so the 5s SIGKILL grace and the 50ms timeout
    // both happen "now". We snapshot the real one so other tests keep
    // working.
    const realSetTimeout = global.setTimeout;
    let armed = 0;
    global.setTimeout = (fn, _ms) => {
      armed += 1;
      // Fire immediately so the timeout path runs synchronously across
      // both arming sites (the outer timeout + the SIGKILL grace).
      return realSetTimeout(fn, 0);
    };
    try {
      // Disable the idle watchdog so this test exercises the absolute
       // timeoutMs path exclusively (the watchdog has its own test below).
      const out = await svc.exec(String(conn._id), 'sleep 999', { userId, timeoutMs: 50, idleTimeoutMs: 0 });
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

  // 6a) exec happy-path returns progress metrics + aborted=undefined (T-387)
  await check('exec() result includes stdoutBytes/stderrBytes/lastChunkAgeMs and aborted is undefined on clean exit', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const factory = makeClientFactory({
      onChannel: (stream) => {
        stream.emit('data', Buffer.from('xyz'));
        stream.stderr.emit('data', Buffer.from('w'));
        stream.emit('exit', 0);
        stream.emit('close');
      },
    });
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

    const userId = new Types.ObjectId().toString();
    const out = await svc.exec(String(conn._id), 'echo xyz', { userId });
    assert.equal(out.stdoutBytes, 3);
    assert.equal(out.stderrBytes, 1);
    assert.ok(typeof out.lastChunkAgeMs === 'number' && out.lastChunkAgeMs >= 0);
    assert.equal(out.aborted, undefined);
    // No errorMsg in audit for clean exit.
    assert.equal(audit._writes[0].errorMsg, undefined);
  });

  // 6b) idle watchdog fires when no output for idleTimeoutMs (T-387)
  await check('exec() idle watchdog escalates with aborted="idle" when remote stays silent', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const captured = [];
    let stuckStream = null;
    const factory = makeClientFactory({
      captureSignals: captured,
      onChannel: (stream) => {
        stuckStream = stream;
        // Channel stays silent — neither emits data nor exit/close. Only the
        // idle watchdog can break this wait.
      },
    });
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

    const userId = new Types.ObjectId().toString();
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, _ms) => realSetTimeout(fn, 0);
    try {
      // timeoutMs is large (won't fire); idleTimeoutMs is tiny → watchdog
      // path is what actually terminates.
      const out = await svc.exec(String(conn._id), 'wedged', {
        userId,
        timeoutMs: 30_000,
        idleTimeoutMs: 50,
      });
      assert.equal(out.aborted, 'idle');
      assert.ok(captured.includes('TERM'), `expected TERM signal, got ${captured.join(',')}`);
      assert.equal(out.exitCode, null);
      // Audit row stamps the idle reason so ops can detect stalls.
      assert.ok(
        /idle_timeout/.test(String(audit._writes[0].errorMsg || '')),
        `expected idle_timeout in errorMsg, got ${audit._writes[0].errorMsg}`,
      );
    } finally {
      global.setTimeout = realSetTimeout;
      if (stuckStream) {
        try { stuckStream.emit('close'); } catch { /* noop */ }
      }
    }
  });

  // 6c) idleTimeoutMs=0 disables the watchdog (legacy quiet-command path)
  await check('exec() with idleTimeoutMs=0 disables the watchdog (only absolute timeoutMs aborts)', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    let stuckStream = null;
    const factory = makeClientFactory({
      onChannel: (stream) => {
        stuckStream = stream;
        // Stay silent forever — without the watchdog, only the absolute
        // timeoutMs can rescue us.
      },
    });
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

    const userId = new Types.ObjectId().toString();
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, _ms) => realSetTimeout(fn, 0);
    try {
      const out = await svc.exec(String(conn._id), 'long quiet sleep', {
        userId,
        timeoutMs: 50,
        idleTimeoutMs: 0,
      });
      // Aborted via absolute timeout, NOT idle.
      assert.equal(out.aborted, 'timeout');
      assert.ok(
        /^timeout/.test(String(audit._writes[0].errorMsg || '')),
        `expected timeout errorMsg, got ${audit._writes[0].errorMsg}`,
      );
    } finally {
      global.setTimeout = realSetTimeout;
      if (stuckStream) {
        try { stuckStream.emit('close'); } catch { /* noop */ }
      }
    }
  });

  // Helper: drain Node's microtask queue until predicate() returns truthy
  // or `maxTicks` passes. The async-exec background runner traverses ~5
  // awaits before `client.exec` actually fires onChannel; tests must poll
  // for that wiring rather than guess a fixed setImmediate count.
  const waitFor = async (predicate, maxTicks = 25) => {
    for (let i = 0; i < maxTicks; i += 1) {
      if (predicate()) return true;
      await new Promise((r) => setImmediate(r));
    }
    return predicate();
  };

  // 6d) execAsync happy-path: returns jobId, then status transitions
  // running → done with collected stdout/stderr tails (T-388)
  await check('execAsync() returns jobId, then status flips to done with collected tails', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    let capturedStream = null;
    const factory = makeClientFactory({
      onChannel: (stream) => {
        capturedStream = stream;
        // Hold the stream open — we drive close manually below so we can
        // observe the running state before finalize.
      },
    });
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

    const userId = new Types.ObjectId().toString();
    const started = await svc.execAsync(String(conn._id), 'echo hi', { userId });
    assert.match(started.jobId, /^ssh-job-/);
    assert.equal(started.command, 'echo hi');
    assert.equal(started.connectionId, String(conn._id));

    // Background runJobBackground traverses several awaits (findById,
    // resolveCredentials, openClient with its 'ready'-nextTick handshake)
    // before runExec wires up the stream handlers. Poll instead of guessing.
    await waitFor(() => capturedStream !== null);
    assert.ok(capturedStream, 'channel handler should be wired up');

    // Emit stdout/stderr while the job is still running — status should
    // reflect bytes received without `state: done` yet.
    capturedStream.emit('data', Buffer.from('hello\n'));
    capturedStream.stderr.emit('data', Buffer.from('warn\n'));

    const mid = svc.getJobStatus(started.jobId);
    assert.ok(mid, 'status snapshot should exist for running job');
    assert.equal(mid.state, 'running');
    assert.equal(mid.stdoutBytes, 6);
    assert.equal(mid.stderrBytes, 5);
    assert.match(mid.stdoutTail, /hello/);
    assert.match(mid.stderrTail, /warn/);

    // Finalise the job and wait for the background task to write the
    // terminal state into the job table.
    capturedStream.emit('exit', 0);
    capturedStream.emit('close');
    await waitFor(() => svc.getJobStatus(started.jobId)?.state !== 'running');

    const done = svc.getJobStatus(started.jobId);
    assert.equal(done.state, 'done');
    assert.equal(done.exitCode, 0);
    assert.equal(done.aborted, null);
    assert.equal(audit._writes.length, 1);
    assert.equal(audit._writes[0].command, 'echo hi');
  });

  // 6e) cancelJob() interrupts a running async job (T-388)
  await check('cancelJob() escalates a running job to aborted="cancelled"', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const captured = [];
    let stuckStream = null;
    const factory = makeClientFactory({
      captureSignals: captured,
      onChannel: (stream) => {
        stuckStream = stream;
        // Stream stays silent — only the cancel hook can break the wait.
      },
    });
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

    const userId = new Types.ObjectId().toString();
    const started = await svc.execAsync(String(conn._id), 'long-runner', {
      userId,
      timeoutMs: 30_000,
      idleTimeoutMs: 0, // disable idle so the cancel is the actual termination cause
    });

    // Wait until the cancel hook + stream handlers are wired up by runExec.
    // We arm the patched setTimeout AFTER this so the real-time 30s
    // timeoutMs setTimeout doesn't get folded into the immediate-fire patch
    // (which would let it escalate('timeout') before our cancel arrives).
    await waitFor(() => stuckStream !== null);
    assert.ok(stuckStream, 'channel handler should be wired up before cancel');

    // Patch ONLY short timeouts (≤ SIGKILL_GRACE_MS + slack). The killTimer
    // armed by escalate uses SIGKILL_GRACE_MS=5_000 and must fire fast in
    // the test; but the JOB_TTL_MS=600_000 cleanup timer also goes through
    // the same global setTimeout — if we shortened that too, the job entry
    // would disappear during the predicate poll and our state assertion
    // would race against the reaper. The 10s cutoff is comfortably above
    // SIGKILL_GRACE_MS and well below JOB_TTL_MS.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => realSetTimeout(fn, (ms ?? 0) < 10_000 ? 0 : ms);
    try {
      const snap = svc.cancelJob(started.jobId);
      assert.ok(snap, 'cancelJob should return a snapshot');
      // Give the SIGKILL grace timer a real chunk of wall-clock time to
      // fire and the post-finalize microtasks (runJobBackground's
      // continuation that stamps job.state) to settle. setImmediate alone
      // races against the timer queue under load; a small real-time wait
      // makes this deterministic.
      await new Promise((r) => realSetTimeout(r, 50));
      const after = svc.getJobStatus(started.jobId);
      assert.equal(after.state, 'aborted', `expected aborted, got ${after.state}; captured=${captured.join(',')}`);
      assert.equal(after.aborted, 'cancelled');
      assert.ok(captured.includes('TERM'), `expected TERM signal, got ${captured.join(',')}`);
      assert.match(String(audit._writes[0].errorMsg || ''), /cancelled/);
    } finally {
      global.setTimeout = realSetTimeout;
      if (stuckStream) {
        try { stuckStream.emit('close'); } catch { /* noop */ }
      }
    }
  });

  // 6f) getJobStatus/cancelJob with unknown jobId return null (T-388)
  await check('getJobStatus()/cancelJob() return null for unknown jobIds', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const factory = makeClientFactory();
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

    assert.equal(svc.getJobStatus('ssh-job-does-not-exist'), null);
    assert.equal(svc.cancelJob('ssh-job-does-not-exist'), null);
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
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

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
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

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
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

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
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

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
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

    // Saturate the in-process semaphore directly via the private methods.
    // The spec mandates max 5 concurrent slots per connection.
    for (let i = 0; i < 5; i += 1) await svc['acquireSlot'](String(conn._id));

    // 6th waiter needs the queue path; squash the 30s wait to ~0.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, _ms) => realSetTimeout(fn, 0);
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
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

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

  // 13) Slot-Transfer: releaseSlot must hand off the slot to a waiter without
  //     dropping active below LIMIT. Reproduces the #C1 race window — a buggy
  //     implementation (state.active -= 1 + waiter.resolve + waiter += 1)
  //     would let a third acquireSlot fast-path in between the -=1 and the
  //     waiter resuming.
  await check('releaseSlot() transfers slot to waiter without breaching LIMIT (no #C1 race)', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const factory = makeClientFactory();
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);
    const connId = String(conn._id);

    // 1) Fill all 5 slots.
    for (let i = 0; i < 5; i += 1) await svc['acquireSlot'](connId);
    let state = svc['concurrency'].get(connId);
    assert.equal(state.active, 5, 'after 5 acquires active must be 5');
    assert.equal(state.queue.length, 0);

    // 2) Two more acquires → both queued.
    let sixthResolved = false;
    let seventhResolved = false;
    const sixth = svc['acquireSlot'](connId).then(() => { sixthResolved = true; });
    const seventh = svc['acquireSlot'](connId).then(() => { seventhResolved = true; });

    await new Promise((r) => setImmediate(r));
    state = svc['concurrency'].get(connId);
    assert.equal(state.active, 5, 'active stays 5 while waiters queue');
    assert.equal(state.queue.length, 2, '6th and 7th are queued');
    assert.equal(sixthResolved, false);
    assert.equal(seventhResolved, false);

    // 3) releaseSlot once — slot transfers to the 6th waiter. Active MUST
    //    stay at 5 (not drop to 4, not grow to 6). The 7th stays queued.
    svc['releaseSlot'](connId);

    // CRITICAL: check active SYNCHRONOUSLY after releaseSlot returns,
    // BEFORE any microtasks/setImmediates run. A #C1-buggy releaseSlot
    // would have already done `state.active -= 1` here (active=4), and
    // the waiter's `state.active += 1` is queued as a microtask that
    // hasn't run yet. The slot-transfer fix keeps active at 5 across
    // this synchronous moment.
    state = svc['concurrency'].get(connId);
    assert.equal(
      state.active,
      5,
      '#C1 race: releaseSlot must NOT drop active below LIMIT mid-handoff (slot-transfer pattern required)',
    );

    // 4) The same micro-window is when a brand-new acquireSlot could
    //    race in via the fast-path. Try it NOW — before awaiting the
    //    6th. With the bug it would resolve synchronously (active was 4,
    //    bumps to 5, returns). With the fix it queues (active is 5).
    let eighthResolved = false;
    const eighth = svc['acquireSlot'](connId).then(() => { eighthResolved = true; });
    // After this synchronous call: the bug version would have queued the
    // microtask for the 8th to resolve already (it'd be on the microtask
    // queue ahead of the 6th's waiter resume). One microtask flush is
    // enough for either bug or fix to express its outcome.
    await new Promise((r) => setImmediate(r));

    await sixth;
    state = svc['concurrency'].get(connId);
    assert.equal(state.active, 5, 'after transfer + queued 8th, active is still 5');
    assert.equal(sixthResolved, true);
    assert.equal(seventhResolved, false, '7th still queued (not its turn)');
    assert.equal(eighthResolved, false, '8th must be queued, not fast-pathed (#C1 race)');
    assert.equal(state.queue.length, 2, '7th + 8th both queued');

    // 5) Drain — release four to free the four remaining slot-holders,
    //    then release once more to clear the 7th waiter, etc. We need 7
    //    total releases (1 already done + 6 more for the 6th-now-active +
    //    4 originals + 2 still-queued waiters).
    // Currently: active=5 (5 slot owners including the 6th), queue=[7th, 8th]
    // Release the 6th → 7th picks up the slot (transfer), active=5, queue=[8th]
    svc['releaseSlot'](connId);
    await seventh;
    assert.equal(seventhResolved, true);
    state = svc['concurrency'].get(connId);
    assert.equal(state.active, 5);
    assert.equal(state.queue.length, 1);

    // Release the 7th → 8th picks up the slot.
    svc['releaseSlot'](connId);
    await eighth;
    assert.equal(eighthResolved, true);
    state = svc['concurrency'].get(connId);
    assert.equal(state.active, 5);
    assert.equal(state.queue.length, 0);

    // Final drain — 5 releases bring active back to 0 and remove the state.
    for (let i = 0; i < 5; i += 1) svc['releaseSlot'](connId);
    assert.equal(svc['concurrency'].get(connId), undefined, 'state cleaned up at active=0');
  });

  // 14) Upload size guard: spec §6.4 caps single upload calls at 10 MB.
  await check('sftpUpload() throws upload_too_large when content exceeds 10 MB', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const sftp = makeFakeSftp({ writeBehaviour: {} });
    const factory = makeClientFactory({ sftp });
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

    const userId = new Types.ObjectId().toString();
    const big = Buffer.alloc(11 * 1024 * 1024); // 11 MB > 10 MB cap
    await assert.rejects(
      () => svc.sftpUpload(String(conn._id), '/srv/big.bin', big, { userId }),
      /upload_too_large: \d+ > \d+/,
    );

    // Slot must be released even on the early-throw path so subsequent
    // ops aren't permanently blocked by the saturated semaphore.
    const state = svc['concurrency'].get(String(conn._id));
    // After the throw, state may be cleaned up (active=0, no waiters) or
    // simply have active=0; either way the next acquireSlot must take
    // the fast path immediately.
    if (state) assert.equal(state.active, 0, 'slot released after upload_too_large');

    // Smoke-check: a fresh acquire works without queueing.
    await svc['acquireSlot'](String(conn._id));
    const afterAcquire = svc['concurrency'].get(String(conn._id));
    assert.equal(afterAcquire.active, 1);
    svc['releaseSlot'](String(conn._id));

    // No audit row for the rejected upload — we never reached the audit
    // write site (intentional: guard fires before findById/audit).
    assert.equal(audit._writes.length, 0);
  });

  // 15) Upload at exactly the cap is still accepted (boundary test).
  await check('sftpUpload() accepts content at exactly 10 MB (cap inclusive)', async () => {
    const conn = makeKeyConnection({ knownHostFingerprint: FAKE_FINGERPRINT });
    const sshService = makeSshServiceStub({ connection: conn });
    const secrets = makeSecretsServiceStub();
    const audit = makeAuditModelStub();
    const writeBehaviour = {};
    const sftp = makeFakeSftp({ writeBehaviour });
    const factory = makeClientFactory({ sftp });
    const svc = new SshSessionService(sshService, secrets, audit, makeNotificationsStub(), makeSettingsStub(), factory);

    const userId = new Types.ObjectId().toString();
    const exact = Buffer.alloc(10 * 1024 * 1024); // 10 MB, == cap
    const out = await svc.sftpUpload(
      String(conn._id),
      '/srv/exact.bin',
      exact,
      { userId },
    );
    assert.equal(out.bytesWritten, 10 * 1024 * 1024);
    assert.equal(audit._writes.length, 1);
    assert.equal(audit._writes[0].action, 'upload');
  });

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log('');
  console.log(`SSH session unit checks: ${total - failures}/${total} passed`);
  if (failures > 0) process.exit(1);
})();
