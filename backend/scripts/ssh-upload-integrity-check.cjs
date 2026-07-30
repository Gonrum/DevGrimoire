#!/usr/bin/env node
/*
 * Regression check for inline-upload integrity (T-435).
 *
 * Covers:
 *   - decodeBase64Strict: valid / whitespace-wrapped / dropped char / stray
 *     char / non-canonical padding / empty
 *   - sha256Hex + assertSha256Matches (match, mismatch, malformed digest,
 *     case + whitespace tolerance)
 *   - sftpUpload append=true opens the remote file with flags 'a'
 *   - sftpUpload append=false keeps truncating semantics (flags 'w')
 *   - sftpUpload append enforces the limit against existing + chunk size,
 *     so repeated small appends cannot walk past the cap
 *   - sftpUpload returns the sha256 of the bytes written
 *
 * Run with `npm run check:ssh-upload-integrity` from backend/ after
 * `npm run build`. No Jest, no real Mongo — exercises the compiled production
 * code, same pattern as the other ssh-* check scripts.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');

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

const integrity = loadCompiled('ssh/upload-integrity.util.js');
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
// Stubs — mirrors scripts/ssh-session-units-check.cjs so both scripts drive the
// service the same way (fingerprint below is what the fake client reports).
// ---------------------------------------------------------------------------
const FAKE_FINGERPRINT =
  '01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:' +
  '01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef';

function makeConnection(overrides = {}) {
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
    tags: [],
    knownHostFingerprint: FAKE_FINGERPRINT,
    notifyOnAuthFailure: false,
    ...overrides,
  };
}

function makeSshServiceStub(connection) {
  return {
    async findById(id) {
      if (!connection || String(connection._id) !== String(id)) {
        const err = new Error('SshConnection not found');
        err.status = 404;
        throw err;
      }
      return connection;
    },
    async recordConnectError() {},
    async recordConnectSuccess() {},
  };
}

const secretsStub = {
  async findById(id) {
    return { _id: String(id), key: 'k', type: 'ssh_key', value: `plain:${id}` };
  },
};
const auditStub = { _writes: [], async create(doc) { this._writes.push(doc); return doc; } };
const notificationsStub = { calls: [], async create() { return {}; } };

function makeSettingsStub(maxUploadBytes = null) {
  return {
    async get(key) {
      if (key === 'ssh.maxUploadBytes') {
        return maxUploadBytes === null ? null : String(maxUploadBytes);
      }
      return null;
    },
  };
}

/**
 * Fake SFTP that records the flags a write stream was opened with and answers
 * stat() from a fixed size (null → ENOENT, i.e. file does not exist).
 */
function makeFakeSftp({ existingSize = null, statError = null, opened = {} } = {}) {
  return {
    createWriteStream(p, opts) {
      opened.path = p;
      opened.flags = opts && opts.flags;
      opened.mode = opts && opts.mode;
      const ws = new EventEmitter();
      ws.write = (chunk, cb) => {
        opened.lastChunk = chunk;
        process.nextTick(() => cb && cb());
        return true;
      };
      ws.end = () => { process.nextTick(() => ws.emit('close')); };
      return ws;
    },
    stat(p, cb) {
      if (statError) {
        process.nextTick(() => cb(statError));
        return;
      }
      if (existingSize === null) {
        // SFTP status 2 = NO_SUCH_FILE, what ssh2 reports for a missing file.
        process.nextTick(() => cb(Object.assign(new Error('No such file'), { code: 2 })));
        return;
      }
      process.nextTick(() => cb(null, { size: existingSize }));
    },
    mkdir(p, cb) { process.nextTick(() => cb(null)); },
    end() {},
  };
}

/**
 * Fake ssh2.Client, reduced to what an SFTP upload needs: drive hostVerifier
 * with the fingerprint above, fire 'ready', hand out the fake SFTP.
 */
function makeClientFactory(sftp) {
  return {
    create: () => {
      const handlers = {};
      const client = {
        on(event, cb) { handlers[event] = cb; return client; },
        end() {},
        destroy() {},
        connect(opts) {
          const hash = Buffer.from(
            '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            'hex',
          );
          let accept = false;
          let cbCalled = false;
          const cb = (a) => { cbCalled = true; accept = a; };
          const ret = opts.hostVerifier ? opts.hostVerifier(hash, cb) : true;
          if (!cbCalled && typeof ret === 'boolean') accept = ret;
          if (!accept) {
            process.nextTick(() => {
              if (handlers.error) handlers.error(new Error('Host key verification failed'));
            });
            return;
          }
          process.nextTick(() => { if (handlers.ready) handlers.ready(); });
        },
        sftp(cb) { process.nextTick(() => cb(undefined, sftp)); return client; },
      };
      return client;
    },
  };
}

function makeService(sftp, settings = makeSettingsStub()) {
  const connection = sftp.__connection;
  return new SshSessionService(
    makeSshServiceStub(connection),
    secretsStub,
    auditStub,
    notificationsStub,
    settings,
    makeClientFactory(sftp),
  );
}

(async () => {
  // -------------------------------------------------------------------------
  // decodeBase64Strict
  // -------------------------------------------------------------------------
  await check('decodeBase64Strict round-trips valid base64', () => {
    const original = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const out = integrity.decodeBase64Strict(original.toString('base64'));
    assert.ok(out.equals(original));
  });

  await check('decodeBase64Strict accepts an empty payload', () => {
    assert.equal(integrity.decodeBase64Strict('').length, 0);
  });

  await check('decodeBase64Strict strips line breaks and spaces', () => {
    const original = Buffer.from('x'.repeat(300));
    const wrapped = original.toString('base64').replace(/(.{60})/g, '$1\r\n');
    assert.ok(integrity.decodeBase64Strict(wrapped).equals(original));
  });

  await check('decodeBase64Strict rejects a dropped character (the field failure)', () => {
    const b64 = Buffer.from('Hello DevGrimoire, a test payload!').toString('base64');
    const dropped = b64.slice(0, 12) + b64.slice(13);
    // Sanity: the lenient decoder would happily accept this.
    assert.notEqual(Buffer.from(dropped, 'base64').length, 0);
    assert.throws(() => integrity.decodeBase64Strict(dropped), /invalid_base64/);
  });

  await check('decodeBase64Strict rejects characters outside the alphabet', () => {
    assert.throws(() => integrity.decodeBase64Strict('SGVsbG8h!!@#'), /alphabet/);
  });

  await check('decodeBase64Strict rejects url-safe base64 (-_ instead of +/)', () => {
    assert.throws(() => integrity.decodeBase64Strict('a-b_cd=='), /alphabet/);
  });

  await check('decodeBase64Strict rejects non-canonical padding bits', () => {
    // "QQ==" and "QR==" both decode to 0x41 with the lenient decoder; only the
    // first is canonical.
    assert.ok(integrity.decodeBase64Strict('QQ==').equals(Buffer.from([0x41])));
    assert.throws(() => integrity.decodeBase64Strict('QR=='), /canonical/);
  });

  // -------------------------------------------------------------------------
  // sha256 helpers
  // -------------------------------------------------------------------------
  await check('sha256Hex matches node crypto', () => {
    const buf = Buffer.from('hello world');
    assert.equal(
      integrity.sha256Hex(buf),
      createHash('sha256').update(buf).digest('hex'),
    );
  });

  await check('assertSha256Matches accepts the correct digest and returns it', () => {
    const buf = Buffer.from('hello world');
    const digest = integrity.sha256Hex(buf);
    assert.equal(integrity.assertSha256Matches(digest, buf), digest);
    assert.equal(integrity.assertSha256Matches(`  ${digest.toUpperCase()} `, buf), digest);
  });

  await check('assertSha256Matches throws checksum_mismatch on wrong digest', () => {
    assert.throws(
      () => integrity.assertSha256Matches('a'.repeat(64), Buffer.from('hello world')),
      /checksum_mismatch/,
    );
  });

  await check('assertSha256Matches rejects a malformed digest', () => {
    assert.throws(
      () => integrity.assertSha256Matches('deadbeef', Buffer.from('x')),
      /invalid_sha256/,
    );
  });

  // -------------------------------------------------------------------------
  // sftpUpload append semantics
  // -------------------------------------------------------------------------
  await check("sftpUpload default opens the remote file with flags 'w'", async () => {
    const opened = {};
    const sftp = makeFakeSftp({ opened });
    sftp.__connection = makeConnection();
    const svc = makeService(sftp);
    const out = await svc.sftpUpload(
      String(sftp.__connection._id), '/tmp/a.bin', Buffer.from('hello'), {},
    );
    assert.equal(opened.flags, 'w');
    assert.equal(out.bytesWritten, 5);
  });

  await check("sftpUpload append=true opens the remote file with flags 'a'", async () => {
    const opened = {};
    const sftp = makeFakeSftp({ existingSize: 100, opened });
    sftp.__connection = makeConnection();
    const svc = makeService(sftp);
    await svc.sftpUpload(
      String(sftp.__connection._id), '/tmp/a.bin', Buffer.from('chunk'), { append: true },
    );
    assert.equal(opened.flags, 'a');
  });

  await check('sftpUpload append=true works when the remote file does not exist yet', async () => {
    const opened = {};
    const sftp = makeFakeSftp({ existingSize: null, opened });
    sftp.__connection = makeConnection();
    const svc = makeService(sftp);
    const out = await svc.sftpUpload(
      String(sftp.__connection._id), '/tmp/new.bin', Buffer.from('first'), { append: true },
    );
    assert.equal(opened.flags, 'a');
    assert.equal(out.bytesWritten, 5);
  });

  await check('sftpUpload append enforces the limit against existing + chunk', async () => {
    const opened = {};
    // Limit 1000, file already 990 bytes, chunk of 20 → must be rejected even
    // though the chunk alone is far below the limit.
    const sftp = makeFakeSftp({ existingSize: 990, opened });
    sftp.__connection = makeConnection();
    const svc = makeService(sftp, makeSettingsStub(1000));
    await assert.rejects(
      () => svc.sftpUpload(
        String(sftp.__connection._id), '/tmp/a.bin', Buffer.alloc(20), { append: true },
      ),
      /upload_too_large/,
    );
    assert.equal(opened.flags, undefined, 'no write stream may be opened');
  });

  await check('sftpUpload append accepts a chunk that still fits the limit', async () => {
    const opened = {};
    const sftp = makeFakeSftp({ existingSize: 900, opened });
    sftp.__connection = makeConnection();
    const svc = makeService(sftp, makeSettingsStub(1000));
    const out = await svc.sftpUpload(
      String(sftp.__connection._id), '/tmp/a.bin', Buffer.alloc(100), { append: true },
    );
    assert.equal(out.bytesWritten, 100);
    assert.equal(opened.flags, 'a');
  });

  await check('sftpUpload append aborts when the baseline size cannot be determined', async () => {
    const opened = {};
    // Permission denied (SFTP status 3) — NOT "file missing". Treating this as
    // size 0 would let repeated appends walk past the limit unnoticed.
    const sftp = makeFakeSftp({
      statError: Object.assign(new Error('Permission denied'), { code: 3 }),
      opened,
    });
    sftp.__connection = makeConnection();
    const svc = makeService(sftp, makeSettingsStub(1000));
    await assert.rejects(
      () => svc.sftpUpload(
        String(sftp.__connection._id), '/tmp/a.bin', Buffer.alloc(10), { append: true },
      ),
      /append_stat_failed/,
    );
    assert.equal(opened.flags, undefined, 'no write stream may be opened');
  });

  await check('sftpUpload returns the sha256 of the bytes written', async () => {
    const sftp = makeFakeSftp({});
    sftp.__connection = makeConnection();
    const svc = makeService(sftp);
    const payload = Buffer.from('hello world');
    const out = await svc.sftpUpload(
      String(sftp.__connection._id), '/tmp/a.bin', payload, {},
    );
    assert.equal(out.sha256, createHash('sha256').update(payload).digest('hex'));
  });

  if (failures > 0) {
    console.error(`\n${failures}/${total} test(s) failed`);
    process.exit(1);
  }
  console.log(`\n${total}/${total} test(s) passed`);
})().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});
