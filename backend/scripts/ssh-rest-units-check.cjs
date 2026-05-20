#!/usr/bin/env node
/*
 * Pure-logic regression check for SshController + SshTestService (T-379,
 * Schritt 2/8 SSH). Mirrors the spec's acceptance set for the REST layer:
 *   - Controller wiring (routes, scope params, response stripping)
 *   - TOFU first-time, match, mismatch
 *   - Auth/timeout error classification
 *   - Audit-write filtering for invalid userIds ('system')
 *
 * Run with `npm run check:ssh-rest` from backend/ after `npm run build`.
 *
 * Same lightweight check style as ssh-service-units-check.cjs — no Jest, no
 * real Mongo. We swap a fake ssh2 client into SshTestService via its third
 * constructor argument (the `clientFactory` seam), and we stub SshService /
 * SecretsService / Mongoose-model interfaces directly.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

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

const { SshTestService } = loadCompiled('ssh/ssh-test.service.js');
const { SshController } = loadCompiled('ssh/ssh.controller.js');
const { SSH_FINGERPRINT_REGEX } = loadCompiled(
  'ssh/dto/accept-fingerprint.dto.js',
);
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
// Fake ssh2 client. Tests drive lifecycle events explicitly via `triggerXyz`.
// ---------------------------------------------------------------------------
function makeFakeClient(behaviour) {
  // `behaviour` is one of:
  //   { kind: 'ready' }                       → ready event after hostVerifier
  //   { kind: 'error', err }                  → error event
  //   { kind: 'authError' }                   → ssh2-style auth-failed error
  //   { kind: 'hostKeyError' }                → ssh2 error after rejecting host
  //   { kind: 'mismatch' }                    → host-key mismatch path
  //   { kind: 'firstTimeError' }              → realistic ssh2: hostVerifier
  //                                              returned accept=false for an
  //                                              unknown host → 'error' fires,
  //                                              not 'ready'.
  //   { kind: 'silent' }                      → never emits → timeout path
  //   { kind: 'throwOnConnect', err }         → connect() throws synchronously
  const handlers = {};
  const client = {
    on(event, cb) {
      handlers[event] = cb;
      return client;
    },
    endCalls: 0,
    destroyCalls: 0,
    end() {
      this.endCalls += 1;
    },
    destroy() {
      this.destroyCalls += 1;
    },
    connect(opts) {
      // Drive the hostVerifier first — exactly what real ssh2 does.
      const hash = Buffer.from(
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        'hex',
      );
      const verifier = opts.hostVerifier;
      let verifierAccept = false;
      // Support both the callback-form and the return-value form so the
      // service can use either without us caring.
      let cbCalled = false;
      const cb = (accept) => {
        cbCalled = true;
        verifierAccept = accept;
      };
      const ret = verifier ? verifier(hash, cb) : true;
      if (!cbCalled && typeof ret === 'boolean') verifierAccept = ret;

      // Mimic ssh2: if verifier rejected, emit error (host key rejected).
      if (!verifierAccept) {
        // Stored fingerprint did NOT match → emit error (mismatch path).
        if (
          behaviour.kind === 'hostKeyError' ||
          behaviour.kind === 'mismatch'
        ) {
          process.nextTick(() => {
            if (handlers.error) {
              const e = new Error('Host key verification failed');
              e.level = 'protocol';
              handlers.error(e);
            }
          });
          return;
        }
        // First-time-fingerprint with realistic ssh2 behaviour: verifier
        // returned false, so ssh2 fires 'error' (NOT 'ready'). This is the
        // path Critical #2 is about.
        if (behaviour.kind === 'firstTimeError') {
          process.nextTick(() => {
            if (handlers.error) {
              const e = new Error('Host key verification failed');
              e.level = 'protocol';
              handlers.error(e);
            }
          });
          return;
        }
        // Legacy permissive behaviour: kind==='ready' models an ssh2 build
        // that ignores the verifier-reject and still emits ready. The
        // service's ready-handler firstTimeFingerprint branch is kept as
        // defense-in-depth for that case.
      }

      if (behaviour.kind === 'throwOnConnect') {
        throw behaviour.err || new Error('synthetic connect throw');
      }
      if (behaviour.kind === 'silent') return; // forces timeout
      if (behaviour.kind === 'ready') {
        process.nextTick(() => {
          if (handlers.ready) handlers.ready();
        });
        return;
      }
      if (behaviour.kind === 'error' || behaviour.kind === 'authError') {
        process.nextTick(() => {
          if (handlers.error) {
            if (behaviour.kind === 'authError') {
              const e = new Error('All configured authentication methods failed');
              e.level = 'client-authentication';
              handlers.error(e);
            } else {
              handlers.error(behaviour.err || new Error('synthetic'));
            }
          }
        });
        return;
      }
    },
  };
  return client;
}

function makeClientFactory(behaviour) {
  return {
    create: () => makeFakeClient(behaviour),
    _lastBehaviour: behaviour,
  };
}

// ---------------------------------------------------------------------------
// Stub services
// ---------------------------------------------------------------------------
function makeSshServiceStub({ connection } = {}) {
  const calls = { recordConnectError: [], recordConnectSuccess: [], setKnownHostFingerprint: [] };
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
    async setKnownHostFingerprint(id, fp) {
      calls.setKnownHostFingerprint.push({ id: String(id), fp });
      connection.knownHostFingerprint = fp;
      return connection;
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

function makeSecretsServiceStub({ failOn = null } = {}) {
  return {
    async findById(id) {
      if (failOn === String(id)) {
        const err = new Error('Secret not found');
        err.status = 404;
        throw err;
      }
      // Return a sensible plaintext for each known id.
      return {
        _id: String(id),
        key: 'k',
        type: 'ssh_key',
        value: `plain:${id}`,
      };
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
    find() {
      const q = {
        sort: () => q,
        skip: () => q,
        limit: () => q,
        lean: () => q,
        exec: async () => writes,
      };
      return q;
    },
    countDocuments() {
      return { exec: async () => writes.length };
    },
  };
}

// ---------------------------------------------------------------------------
// Connection-builder helpers
// ---------------------------------------------------------------------------
function makeKeyConnection(overrides = {}) {
  return {
    _id: new Types.ObjectId(),
    label: 'web-01',
    slug: 'web-01',
    customerId: new Types.ObjectId(),
    projectId: undefined,
    host: 'localhost',
    port: 22,
    username: 'deploy',
    authMethod: 'key',
    privateKeySecretId: new Types.ObjectId(),
    passphraseSecretId: undefined,
    passwordSecretId: undefined,
    tags: ['prod'],
    description: 'web frontend',
    knownHostFingerprint: undefined,
    lastConnectedAt: undefined,
    lastConnectError: undefined,
    notifyOnAuthFailure: false,
    ...overrides,
  };
}

function makePasswordConnection(overrides = {}) {
  return {
    _id: new Types.ObjectId(),
    label: 'db-01',
    slug: 'db-01',
    customerId: undefined,
    projectId: new Types.ObjectId(),
    host: '10.0.0.5',
    port: 22,
    username: 'admin',
    authMethod: 'password',
    privateKeySecretId: undefined,
    passphraseSecretId: undefined,
    passwordSecretId: new Types.ObjectId(),
    tags: [],
    description: undefined,
    knownHostFingerprint: undefined,
    lastConnectedAt: undefined,
    lastConnectError: undefined,
    notifyOnAuthFailure: true,
    ...overrides,
  };
}

(async () => {
  // ------------------------------------------------------------------
  // DTO format regex sanity-check
  // ------------------------------------------------------------------
  await check('SSH_FINGERPRINT_REGEX accepts canonical lowercase hex bytes', () => {
    const fp =
      '00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:' +
      '00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff';
    assert.equal(fp.length, 95);
    assert.ok(SSH_FINGERPRINT_REGEX.test(fp));
  });
  await check('SSH_FINGERPRINT_REGEX rejects uppercase / wrong-length', () => {
    assert.equal(SSH_FINGERPRINT_REGEX.test('AA:BB:CC'), false);
    assert.equal(
      SSH_FINGERPRINT_REGEX.test(
        'gg:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff',
      ),
      false,
    );
  });

  // ------------------------------------------------------------------
  // SshTestService: TOFU first-time
  // ------------------------------------------------------------------
  await check('testConnection() returns ok=false + fingerprint on first-time host key', async () => {
    const conn = makeKeyConnection();
    const sshService = makeSshServiceStub({ connection: conn });
    const secretsService = makeSecretsServiceStub();
    const auditModel = makeAuditModelStub();
    const factory = makeClientFactory({ kind: 'ready' });

    const svc = new SshTestService(sshService, secretsService, auditModel, makeNotificationsStub(), factory);
    const result = await svc.testConnection(String(conn._id), {
      userId: new Types.ObjectId().toString(),
    });

    assert.equal(result.ok, false, 'first-time fingerprint requires user accept');
    assert.ok(result.fingerprint, 'fingerprint surfaces to the UI');
    assert.match(result.fingerprint, SSH_FINGERPRINT_REGEX);
    assert.equal(result.fingerprintMismatch, undefined);
    assert.equal(result.error, undefined);

    // Neither success nor error gets recorded for pending-fingerprint — we
    // intentionally don't clobber lastConnectError here. Audit gets ONE
    // entry (the connect attempt) when we have a valid userId.
    assert.equal(sshService.calls.recordConnectSuccess.length, 0);
    assert.equal(sshService.calls.recordConnectError.length, 0);
    assert.equal(auditModel._writes.length, 1);
    assert.equal(auditModel._writes[0].action, 'connect');
    assert.equal(auditModel._writes[0].sourceContext, 'rest');
    assert.equal(auditModel._writes[0].errorMsg, undefined);
  });

  // ------------------------------------------------------------------
  // SshTestService: TOFU first-time via the realistic ssh2 'error' path.
  // Critical #2 regression: the previous implementation only handled the
  // first-time-fingerprint case in the 'ready' handler, which is dead-code
  // because ssh2 emits 'error' (not 'ready') when hostVerifier returns
  // accept=false. Without this branch the user got a generic auth_failed/
  // unknown response and never saw the accept-fingerprint dialog.
  // ------------------------------------------------------------------
  await check(
    'testConnection() returns ok=false + fingerprint when ssh2 emits error after first-time hostVerifier reject',
    async () => {
      const conn = makeKeyConnection();
      const sshService = makeSshServiceStub({ connection: conn });
      const secretsService = makeSecretsServiceStub();
      const auditModel = makeAuditModelStub();
      const factory = makeClientFactory({ kind: 'firstTimeError' });

      const svc = new SshTestService(sshService, secretsService, auditModel, makeNotificationsStub(), factory);
      const result = await svc.testConnection(String(conn._id), {
        userId: new Types.ObjectId().toString(),
      });

      // Behaves exactly like the 'ready'-path first-time case from the
      // caller's perspective: ok=false, fingerprint surfaces, no error
      // code is set (we want the UI to render the accept dialog, not an
      // error banner).
      assert.equal(result.ok, false);
      assert.ok(result.fingerprint, 'fingerprint must surface to the UI');
      assert.match(result.fingerprint, SSH_FINGERPRINT_REGEX);
      assert.equal(result.fingerprintMismatch, undefined);
      assert.equal(result.error, undefined, 'no error code on first-time pending');

      // No success / no error persisted — pending state must not clobber
      // lastConnect* fields either way.
      assert.equal(sshService.calls.recordConnectSuccess.length, 0);
      assert.equal(sshService.calls.recordConnectError.length, 0);
    },
  );

  // ------------------------------------------------------------------
  // SshTestService: audit-write failure path (Important #4).
  // The audit insert is fire-and-forget. We verify the user-facing result
  // is unaffected and that the failure surfaces via logger.warn so an op
  // can find it in the log stream.
  // ------------------------------------------------------------------
  await check(
    'testConnection() resolves with the correct result even when audit-write throws',
    async () => {
      const expectedFp =
        '01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:' +
        '01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef';
      const conn = makeKeyConnection({ knownHostFingerprint: expectedFp });
      const sshService = makeSshServiceStub({ connection: conn });
      const secretsService = makeSecretsServiceStub();
      // Audit model that always blows up on create():
      const failingAuditModel = {
        _writes: [],
        async create() {
          throw new Error('synthetic mongo write failure');
        },
      };
      const factory = makeClientFactory({ kind: 'ready' });

      const svc = new SshTestService(sshService, secretsService, failingAuditModel, makeNotificationsStub(), factory);

      // Spy the logger so we can prove the warn fires.
      const warnCalls = [];
      svc.logger = { warn: (msg) => warnCalls.push(String(msg)) };

      const result = await svc.testConnection(String(conn._id), {
        userId: new Types.ObjectId().toString(),
      });

      // User still sees the ok=true result — audit is best-effort.
      assert.equal(result.ok, true);
      assert.equal(result.fingerprintAccepted, true);
      // recordConnectSuccess still ran (it doesn't depend on audit).
      assert.equal(sshService.calls.recordConnectSuccess.length, 1);
      // logger.warn was invoked at least once for the audit failure path.
      // persist() runs after resolve(); poll a handful of ticks for the
      // background .catch to land.
      for (let i = 0; i < 20 && warnCalls.length === 0; i += 1) {
        await new Promise((r) => setImmediate(r));
      }
      assert.ok(
        warnCalls.some((m) => /Audit persistence failed/i.test(m)),
        `expected logger.warn call mentioning audit failure, got ${JSON.stringify(warnCalls)}`,
      );
    },
  );

  // ------------------------------------------------------------------
  // SshTestService: TOFU known fingerprint match
  // ------------------------------------------------------------------
  await check('testConnection() returns ok=true when stored fingerprint matches', async () => {
    // Expected canonical form for our fake hash:
    const expectedFp =
      '01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:' +
      '01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef';
    const conn = makeKeyConnection({ knownHostFingerprint: expectedFp });
    const sshService = makeSshServiceStub({ connection: conn });
    const secretsService = makeSecretsServiceStub();
    const auditModel = makeAuditModelStub();
    const factory = makeClientFactory({ kind: 'ready' });

    const svc = new SshTestService(sshService, secretsService, auditModel, makeNotificationsStub(), factory);
    const result = await svc.testConnection(String(conn._id), {
      userId: new Types.ObjectId().toString(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.fingerprintAccepted, true);
    assert.equal(result.fingerprintMismatch, undefined);
    assert.equal(result.error, undefined);
    assert.equal(sshService.calls.recordConnectSuccess.length, 1);
    assert.equal(sshService.calls.recordConnectError.length, 0);
  });

  // ------------------------------------------------------------------
  // SshTestService: TOFU mismatch
  // ------------------------------------------------------------------
  await check('testConnection() returns host_key_mismatch when stored fingerprint differs', async () => {
    const conn = makeKeyConnection({
      knownHostFingerprint:
        'ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:' +
        'ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff:ff',
    });
    const sshService = makeSshServiceStub({ connection: conn });
    const secretsService = makeSecretsServiceStub();
    const auditModel = makeAuditModelStub();
    const factory = makeClientFactory({ kind: 'mismatch' });

    const svc = new SshTestService(sshService, secretsService, auditModel, makeNotificationsStub(), factory);
    const result = await svc.testConnection(String(conn._id), {
      userId: new Types.ObjectId().toString(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.fingerprintMismatch, true);
    assert.ok(result.error);
    assert.equal(result.error.code, 'host_key_mismatch');
    assert.equal(sshService.calls.recordConnectError.length, 1);
    assert.match(sshService.calls.recordConnectError[0].msg, /host_key_mismatch/);
  });

  // ------------------------------------------------------------------
  // SshTestService: auth failed
  // ------------------------------------------------------------------
  await check('testConnection() classifies auth failure as code=auth_failed', async () => {
    // Pre-accept the fingerprint so the verifier returns true and the
    // handshake proceeds to the auth phase.
    const expectedFp =
      '01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:' +
      '01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef';
    const conn = makeKeyConnection({ knownHostFingerprint: expectedFp });
    const sshService = makeSshServiceStub({ connection: conn });
    const secretsService = makeSecretsServiceStub();
    const auditModel = makeAuditModelStub();
    const factory = makeClientFactory({ kind: 'authError' });

    const svc = new SshTestService(sshService, secretsService, auditModel, makeNotificationsStub(), factory);
    const result = await svc.testConnection(String(conn._id), {
      userId: new Types.ObjectId().toString(),
    });

    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(result.error.code, 'auth_failed');
    assert.equal(sshService.calls.recordConnectError.length, 1);
    assert.match(sshService.calls.recordConnectError[0].msg, /auth_failed/);
    assert.equal(auditModel._writes.length, 1);
    assert.match(auditModel._writes[0].errorMsg, /auth_failed/);
  });

  // ------------------------------------------------------------------
  // SshTestService: timeout
  // ------------------------------------------------------------------
  // Skip the real 10s wait by injecting a tiny CONNECT_TIMEOUT_MS via a fake
  // setTimeout? Simpler: just override globalThis.setTimeout to immediately
  // run the callback for this test. Tests run in isolation so this is safe.
  await check('testConnection() returns code=timeout when the client never emits ready', async () => {
    const expectedFp =
      '01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:' +
      '01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef';
    const conn = makeKeyConnection({ knownHostFingerprint: expectedFp });
    const sshService = makeSshServiceStub({ connection: conn });
    const secretsService = makeSecretsServiceStub();
    const auditModel = makeAuditModelStub();
    const factory = makeClientFactory({ kind: 'silent' });

    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, _ms) => realSetTimeout(fn, 0);
    try {
      const svc = new SshTestService(sshService, secretsService, auditModel, makeNotificationsStub(), factory);
      const result = await svc.testConnection(String(conn._id), {
        userId: new Types.ObjectId().toString(),
      });
      assert.equal(result.ok, false);
      assert.ok(result.error);
      assert.equal(result.error.code, 'timeout');
      assert.match(result.error.message, /timeout/i);
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });

  // ------------------------------------------------------------------
  // SshTestService: credential missing
  // ------------------------------------------------------------------
  await check('testConnection() returns credential_missing when secret is gone', async () => {
    const conn = makeKeyConnection();
    const sshService = makeSshServiceStub({ connection: conn });
    const secretsService = makeSecretsServiceStub({
      failOn: String(conn.privateKeySecretId),
    });
    const auditModel = makeAuditModelStub();
    const factory = makeClientFactory({ kind: 'ready' }); // never reached

    const svc = new SshTestService(sshService, secretsService, auditModel, makeNotificationsStub(), factory);
    const result = await svc.testConnection(String(conn._id), {
      userId: new Types.ObjectId().toString(),
    });

    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(result.error.code, 'credential_missing');
    assert.equal(sshService.calls.recordConnectError.length, 1);
    assert.equal(auditModel._writes.length, 1);
    assert.match(auditModel._writes[0].errorMsg, /credential_missing/);
  });

  // ------------------------------------------------------------------
  // Audit-write filter: 'system' userId is dropped, not persisted
  // ------------------------------------------------------------------
  await check('audit write is skipped when userId is not a valid ObjectId', async () => {
    const conn = makeKeyConnection();
    const sshService = makeSshServiceStub({ connection: conn });
    const secretsService = makeSecretsServiceStub({
      failOn: String(conn.privateKeySecretId),
    });
    const auditModel = makeAuditModelStub();
    const factory = makeClientFactory({ kind: 'ready' });

    const svc = new SshTestService(sshService, secretsService, auditModel, makeNotificationsStub(), factory);
    const result = await svc.testConnection(String(conn._id), { userId: 'system' });

    assert.equal(result.ok, false);
    // No audit row written for 'system' caller (would violate schema's
    // ObjectId userId constraint at write time).
    assert.equal(auditModel._writes.length, 0);
  });

  // ------------------------------------------------------------------
  // SshController: response shape strips credentials, includes secret IDs
  // ------------------------------------------------------------------
  await check('SshController.findOne() returns secret IDs but no plaintext fields', async () => {
    const conn = makeKeyConnection({
      knownHostFingerprint:
        '01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:' +
        '01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef',
    });
    const sshService = makeSshServiceStub({ connection: conn });
    const auditModel = makeAuditModelStub();
    const ctrl = new SshController(sshService, /* testSvc */ {}, auditModel);
    const out = await ctrl.findOne(String(conn._id));
    assert.equal(out.id, String(conn._id));
    assert.equal(out.label, 'web-01');
    assert.equal(out.host, 'localhost');
    assert.equal(out.authMethod, 'key');
    assert.equal(out.privateKeySecretId, String(conn.privateKeySecretId));
    assert.equal(out.knownHostFingerprintSet, true);
    assert.ok(out.knownHostFingerprint);
    // Crucially: no plaintext credential keys leak through.
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'privateKey'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'password'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'passphrase'), false);
  });

  await check('SshController.findOne() for password conn shows password secret id only', async () => {
    const conn = makePasswordConnection();
    const sshService = makeSshServiceStub({ connection: conn });
    const auditModel = makeAuditModelStub();
    const ctrl = new SshController(sshService, /* testSvc */ {}, auditModel);
    const out = await ctrl.findOne(String(conn._id));
    assert.equal(out.passwordSecretId, String(conn.passwordSecretId));
    assert.equal(out.privateKeySecretId, undefined);
    assert.equal(out.knownHostFingerprintSet, false);
  });

  // ------------------------------------------------------------------
  // SshController: listByQuery rejects ambiguous / empty input
  // ------------------------------------------------------------------
  await check('SshController.listByQuery() rejects when neither customerId nor projectId is set', async () => {
    const conn = makeKeyConnection();
    const sshService = makeSshServiceStub({ connection: conn });
    const auditModel = makeAuditModelStub();
    const ctrl = new SshController(sshService, /* testSvc */ {}, auditModel);
    await assert.rejects(() => ctrl.listByQuery({}), /required/i);
  });

  await check('SshController.listByQuery() rejects when both ids are set', async () => {
    const conn = makeKeyConnection();
    const sshService = makeSshServiceStub({ connection: conn });
    const auditModel = makeAuditModelStub();
    const ctrl = new SshController(sshService, /* testSvc */ {}, auditModel);
    await assert.rejects(
      () =>
        ctrl.listByQuery({
          customerId: new Types.ObjectId().toString(),
          projectId: new Types.ObjectId().toString(),
        }),
      /mutually exclusive/i,
    );
  });

  // ------------------------------------------------------------------
  // SshController: test endpoint delegates to SshTestService
  // ------------------------------------------------------------------
  await check('SshController.test() forwards userId from req.user to SshTestService', async () => {
    const conn = makeKeyConnection();
    const calls = [];
    const sshService = makeSshServiceStub({ connection: conn });
    const auditModel = makeAuditModelStub();
    const testSvc = {
      async testConnection(id, opts) {
        calls.push({ id, opts });
        return { ok: true };
      },
    };
    const ctrl = new SshController(sshService, testSvc, auditModel);
    const userId = new Types.ObjectId().toString();
    const out = await ctrl.test(String(conn._id), {}, { user: { userId } });
    assert.equal(out.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, String(conn._id));
    assert.equal(calls[0].opts.userId, userId);
  });

  // ------------------------------------------------------------------
  // SshController: accept-fingerprint stores the new fingerprint
  // ------------------------------------------------------------------
  await check('SshController.acceptFingerprint() persists via SshService.setKnownHostFingerprint', async () => {
    const conn = makeKeyConnection();
    const sshService = makeSshServiceStub({ connection: conn });
    const auditModel = makeAuditModelStub();
    const ctrl = new SshController(sshService, /* testSvc */ {}, auditModel);
    const fp =
      'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:' +
      'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99';
    const out = await ctrl.acceptFingerprint(String(conn._id), { fingerprint: fp });
    assert.equal(out.knownHostFingerprint, fp);
    assert.equal(sshService.calls.setKnownHostFingerprint.length, 1);
    assert.equal(sshService.calls.setKnownHostFingerprint[0].fp, fp);
  });

  // ------------------------------------------------------------------
  // SshController: audit() rejects invalid ids
  // ------------------------------------------------------------------
  await check('SshController.audit() rejects when id is not a valid ObjectId', async () => {
    const conn = makeKeyConnection();
    const sshService = makeSshServiceStub({ connection: conn });
    const auditModel = makeAuditModelStub();
    const ctrl = new SshController(sshService, /* testSvc */ {}, auditModel);
    await assert.rejects(() => ctrl.audit('not-an-id', {}), /Invalid SshConnection id/);
  });

  await check('SshController.audit() returns { items, total, limit, offset } shape', async () => {
    const conn = makeKeyConnection();
    const sshService = makeSshServiceStub({ connection: conn });
    const auditModel = makeAuditModelStub();
    // Seed an entry.
    auditModel._writes.push({
      connectionId: conn._id,
      action: 'connect',
      sourceContext: 'rest',
    });
    const ctrl = new SshController(sshService, /* testSvc */ {}, auditModel);
    const out = await ctrl.audit(String(conn._id), {});
    assert.deepEqual(Object.keys(out).sort(), ['items', 'limit', 'offset', 'total']);
    assert.equal(out.limit, 50);
    assert.equal(out.offset, 0);
    assert.equal(out.total, 1);
    assert.equal(out.items.length, 1);
  });

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log('');
  console.log(`SSH REST/test unit checks: ${total - failures}/${total} passed`);
  if (failures > 0) process.exit(1);
})();
