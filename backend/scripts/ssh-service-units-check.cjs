#!/usr/bin/env node
/*
 * Pure-logic regression check for SshService (T-378, Schritt 1/8 SSH).
 * Mirrors the spec's acceptance set: scope validator, auth validator,
 * cascade-delete, create-rollback. Loads compiled artifacts from dist/.
 *
 * Run with `npm run check:ssh-service` from backend/ after `npm run build`.
 *
 * NOTE: This is the same lightweight check-style used elsewhere in the repo
 * (cf. scripts/workflow-runner-units-check.cjs) — we don't yet have Jest +
 * mongodb-memory-server set up. The Mongoose layer is stubbed with an
 * in-memory model that captures the behaviours we care about for THIS step
 * (CRUD against fake docs, secret-ownership cascade, rollback on create
 * failure). Integration with real Mongoose / Mongo runs in `check:` HTTP
 * tests once the REST layer (Schritt 2/8) lands.
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

const { SshService } = loadCompiled('ssh/ssh.service.js');
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

// ------------------------------------------------------------------
// Lightweight in-memory Mongoose model surrogate.
// We only implement what SshService actually calls.
// ------------------------------------------------------------------
function makeStore() {
  return new Map(); // id-string -> doc
}

function cloneDoc(doc) {
  // Shallow-clone but keep ObjectId instances intact.
  return Object.assign({}, doc);
}

function matchesFilter(doc, filter) {
  for (const [k, v] of Object.entries(filter || {})) {
    if (k === '_id') {
      if (v && typeof v === 'object' && '$in' in v) {
        const ids = v.$in.map(String);
        if (!ids.includes(String(doc._id))) return false;
      } else if (String(doc._id) !== String(v)) {
        return false;
      }
    } else if (v && typeof v === 'object' && '$in' in v) {
      const set = v.$in.map(String);
      if (!set.includes(String(doc[k]))) return false;
    } else if (v === undefined || v === null) {
      if (doc[k] !== v) return false;
    } else if (String(doc[k]) !== String(v)) {
      return false;
    }
  }
  return true;
}

function applyUpdate(doc, update) {
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$unset) {
    for (const k of Object.keys(update.$unset)) delete doc[k];
  }
  if (update.$inc) {
    for (const [k, v] of Object.entries(update.$inc)) {
      doc[k] = (typeof doc[k] === 'number' ? doc[k] : 0) + v;
    }
  }
}

class FakeQuery {
  constructor(result) {
    this._result = result;
  }
  exec() {
    return Promise.resolve(this._result);
  }
  sort() {
    return this;
  }
  lean() {
    return this;
  }
}

function makeModel(name) {
  const store = makeStore();
  const schemaInvariants = name === 'SshConnection' ? sshInvariants : null;

  class FakeDoc {
    constructor(data) {
      Object.assign(this, data);
      if (!this._id) this._id = new Types.ObjectId();
      // Mongoose-style version key default. SshService's update() reads
      // `doc.__v` and uses it as an optimistic-concurrency-control filter.
      if (this.__v === undefined) this.__v = 0;
    }
    async save() {
      if (schemaInvariants) schemaInvariants(this);
      // Enforce unique-slug-per-scope (mirrors the Mongo partial unique indexes).
      if (name === 'SshConnection') {
        for (const other of store.values()) {
          if (String(other._id) === String(this._id)) continue;
          if (other.slug !== this.slug) continue;
          if (
            this.customerId &&
            other.customerId &&
            String(other.customerId) === String(this.customerId)
          ) {
            const e = new Error('duplicate key');
            e.code = 11000;
            throw e;
          }
          if (
            this.projectId &&
            other.projectId &&
            String(other.projectId) === String(this.projectId)
          ) {
            const e = new Error('duplicate key');
            e.code = 11000;
            throw e;
          }
        }
      }
      store.set(String(this._id), this);
      return this;
    }
  }

  return {
    _store: store,
    async create(data) {
      const doc = new FakeDoc(data);
      await doc.save();
      return doc;
    },
    findById(id) {
      const doc = store.get(String(id));
      return new FakeQuery(doc ? doc : null);
    },
    findOne(filter) {
      for (const doc of store.values()) {
        if (matchesFilter(doc, filter)) return new FakeQuery(doc);
      }
      return new FakeQuery(null);
    },
    find(filter) {
      const out = [];
      for (const doc of store.values()) {
        if (matchesFilter(doc, filter)) out.push(doc);
      }
      return new FakeQuery(out);
    },
    deleteOne(filter) {
      for (const [k, doc] of store.entries()) {
        if (matchesFilter(doc, filter)) {
          store.delete(k);
          return new FakeQuery({ deletedCount: 1 });
        }
      }
      return new FakeQuery({ deletedCount: 0 });
    },
    deleteMany(filter) {
      let n = 0;
      for (const [k, doc] of [...store.entries()]) {
        if (matchesFilter(doc, filter)) {
          store.delete(k);
          n += 1;
        }
      }
      return new FakeQuery({ deletedCount: n });
    },
    updateMany(filter, update) {
      let n = 0;
      for (const doc of store.values()) {
        if (matchesFilter(doc, filter)) {
          applyUpdate(doc, update);
          n += 1;
        }
      }
      return new FakeQuery({ modifiedCount: n });
    },
    findByIdAndDelete(id) {
      const doc = store.get(String(id));
      if (doc) store.delete(String(id));
      return new FakeQuery(doc || null);
    },
    findOneAndUpdate(filter, update, opts) {
      for (const doc of store.values()) {
        if (matchesFilter(doc, filter)) {
          applyUpdate(doc, update);
          return new FakeQuery(doc);
        }
      }
      if (opts && opts.upsert) {
        const seed = Object.assign({}, update.$set || {});
        for (const [k, v] of Object.entries(filter || {})) {
          if (seed[k] === undefined) seed[k] = v;
        }
        const doc = new FakeDoc(seed);
        store.set(String(doc._id), doc);
        return new FakeQuery(doc);
      }
      return new FakeQuery(null);
    },
  };
}

// Schema-side invariants — kept in sync with ssh-connection.schema.ts so the
// fake DB layer rejects the same inputs the real one would.
function sshInvariants(doc) {
  const hasC = !!doc.customerId;
  const hasP = !!doc.projectId;
  if (hasC === hasP) {
    throw new Error('exactly one of customerId/projectId required');
  }
  if (doc.authMethod === 'key') {
    if (!doc.privateKeySecretId) throw new Error('key needs privateKeySecretId');
    if (doc.passwordSecretId) throw new Error('key forbids passwordSecretId');
  } else if (doc.authMethod === 'password') {
    if (!doc.passwordSecretId) throw new Error('password needs passwordSecretId');
    if (doc.privateKeySecretId || doc.passphraseSecretId) {
      throw new Error('password forbids key fields');
    }
  } else {
    throw new Error(`authMethod must be 'key' or 'password'`);
  }
}

// ------------------------------------------------------------------
// SecretsService stub: emulates create() with deterministic ids, plus a
// "fail at next create" hook for the rollback test.
// ------------------------------------------------------------------
function makeSecretsServiceWith(secretModel) {
  let failNext = false;
  const svc = {
    failNextCreate() {
      failNext = true;
    },
    async create(dto) {
      if (failNext) {
        failNext = false;
        throw new Error('synthetic SecretsService.create failure');
      }
      const _id = new Types.ObjectId();
      const doc = {
        _id,
        projectId: dto.projectId ? new Types.ObjectId(dto.projectId) : undefined,
        customerId: dto.customerId ? new Types.ObjectId(dto.customerId) : undefined,
        environmentId: dto.environmentId || null,
        key: dto.key,
        type: dto.type || 'variable',
        description: dto.description,
        // We don't actually encrypt in the stub — value held in-memory.
        encryptedValue: `enc:${dto.value}`,
      };
      secretModel._store.set(String(_id), doc);
      return {
        _id: String(_id),
        projectId: doc.projectId ? String(doc.projectId) : null,
        customerId: doc.customerId ? String(doc.customerId) : null,
        environmentId: doc.environmentId,
        key: doc.key,
        type: doc.type,
        description: doc.description,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
  };
  return svc;
}

// ------------------------------------------------------------------
// Helpers to build a fresh world per test.
// ------------------------------------------------------------------
function newWorld() {
  const sshModel = makeModel('SshConnection');
  const secretModel = makeModel('Secret');
  // SshAudit model surface (only `findOne` + `countDocuments` are exercised
  // by SshService.findLatestAudit; these tests don't go near it, but we
  // still need a non-undefined object so constructor wiring is valid).
  const auditModel = makeModel('SshAudit');
  const secretsService = makeSecretsServiceWith(secretModel);
  // Fake EventEmitter2 — captures emits without firing handlers so unit
  // tests can assert (or just ignore) the new ssh-connection change events.
  const events = [];
  const eventEmitter = {
    emit(name, payload) { events.push({ name, payload }); return true; },
    events,
  };
  const svc = new SshService(sshModel, secretModel, auditModel, secretsService, eventEmitter);
  return { svc, sshModel, secretModel, auditModel, secretsService, eventEmitter };
}

const customerId = new Types.ObjectId().toString();
const projectId = new Types.ObjectId().toString();
const userId = new Types.ObjectId().toString();

(async () => {
  // ----------------------------------------------------------------
  // Scope validator
  // ----------------------------------------------------------------
  await check('create() throws when neither customerId nor projectId is set', async () => {
    const { svc } = newWorld();
    await assert.rejects(
      () =>
        svc.create(
          {
            label: 'no-scope',
            slug: 'no-scope',
            host: 'h',
            username: 'u',
            authMethod: 'password',
            inlineSecrets: { password: { password: 'pw' } },
          },
          userId,
        ),
      /exactly one of customerId/i,
    );
  });

  await check('create() throws when BOTH customerId and projectId are set', async () => {
    const { svc } = newWorld();
    await assert.rejects(
      () =>
        svc.create(
          {
            label: 'dual-scope',
            slug: 'dual-scope',
            customerId,
            projectId,
            host: 'h',
            username: 'u',
            authMethod: 'password',
            inlineSecrets: { password: { password: 'pw' } },
          },
          userId,
        ),
      /cannot have both/i,
    );
  });

  // ----------------------------------------------------------------
  // Auth validator
  // ----------------------------------------------------------------
  await check('create() throws when authMethod=key but no privateKey source', async () => {
    const { svc } = newWorld();
    await assert.rejects(
      () =>
        svc.create(
          {
            label: 'k1',
            slug: 'k1',
            customerId,
            host: 'h',
            username: 'u',
            authMethod: 'key',
            // no inlineSecrets.key, no privateKeySecretId
          },
          userId,
        ),
      /privateKeySecretId/,
    );
  });

  await check('create() throws when authMethod=key but also passwordSecretId given', async () => {
    const { svc } = newWorld();
    await assert.rejects(
      () =>
        svc.create(
          {
            label: 'k2',
            slug: 'k2',
            customerId,
            host: 'h',
            username: 'u',
            authMethod: 'key',
            inlineSecrets: { key: { privateKey: '----KEY----' } },
            passwordSecretId: new Types.ObjectId().toString(),
          },
          userId,
        ),
      /must not provide password/,
    );
  });

  await check('create() throws when authMethod=password but no password source', async () => {
    const { svc } = newWorld();
    await assert.rejects(
      () =>
        svc.create(
          {
            label: 'p1',
            slug: 'p1',
            customerId,
            host: 'h',
            username: 'u',
            authMethod: 'password',
          },
          userId,
        ),
      /passwordSecretId/,
    );
  });

  // ----------------------------------------------------------------
  // Happy path: inline key creates owned secrets and stamps ownership
  // ----------------------------------------------------------------
  await check('create() with inline key stores ownedBySshConnectionId on the secret', async () => {
    const { svc, sshModel, secretModel } = newWorld();
    const conn = await svc.create(
      {
        label: 'web-01',
        slug: 'web-01',
        customerId,
        host: 'h',
        port: 2222,
        username: 'u',
        authMethod: 'key',
        inlineSecrets: { key: { privateKey: '----KEY----', passphrase: 'pp' } },
      },
      userId,
    );
    assert.equal(conn.label, 'web-01');
    assert.equal(conn.port, 2222);
    assert.ok(conn.privateKeySecretId);
    assert.ok(conn.passphraseSecretId);

    // Sanity: connection actually landed in the store.
    assert.equal(sshModel._store.size, 1);

    // Both new secrets must carry the ownership stamp.
    const pk = secretModel._store.get(String(conn.privateKeySecretId));
    const pp = secretModel._store.get(String(conn.passphraseSecretId));
    assert.ok(pk, 'private key secret persisted');
    assert.ok(pp, 'passphrase secret persisted');
    assert.equal(String(pk.ownedBySshConnectionId), String(conn._id));
    assert.equal(String(pp.ownedBySshConnectionId), String(conn._id));
  });

  // ----------------------------------------------------------------
  // Cascade-delete: owned dies, picked stays
  // ----------------------------------------------------------------
  await check('delete() cascades only owned secrets and leaves picked ones alone', async () => {
    const { svc, secretsService, secretModel } = newWorld();

    // Pre-seed a "picked existing" secret — NO ownedBy stamp.
    const pickedId = new Types.ObjectId();
    secretModel._store.set(String(pickedId), {
      _id: pickedId,
      customerId: new Types.ObjectId(customerId),
      environmentId: null,
      key: 'preexisting-key',
      type: 'ssh_key',
      encryptedValue: 'enc:OLD',
    });

    // Connection created with inline key (-> owned secrets exist alongside).
    const conn = await svc.create(
      {
        label: 'mixed',
        slug: 'mixed',
        customerId,
        host: 'h',
        username: 'u',
        authMethod: 'key',
        inlineSecrets: { key: { privateKey: 'pem', passphrase: 'pp' } },
      },
      userId,
    );

    // ALSO put a second standalone picked secret in the same scope to be
    // safe: gets ignored regardless.
    const otherId = new Types.ObjectId();
    secretModel._store.set(String(otherId), {
      _id: otherId,
      customerId: new Types.ObjectId(customerId),
      environmentId: null,
      key: 'unrelated',
      type: 'variable',
      encryptedValue: 'enc:OTHER',
    });

    const ownedIds = [conn.privateKeySecretId, conn.passphraseSecretId].map(String);
    assert.equal(secretModel._store.size, 4, 'pre-delete: 2 owned + 2 picked');

    await svc.delete(String(conn._id));

    // Owned must be gone.
    for (const id of ownedIds) {
      assert.equal(secretModel._store.has(id), false, `owned ${id} should be deleted`);
    }
    // Picked must remain.
    assert.equal(secretModel._store.has(String(pickedId)), true, 'picked secret preserved');
    assert.equal(secretModel._store.has(String(otherId)), true, 'unrelated secret preserved');

    // Suppress unused-var warning for the stub instance.
    void secretsService;
  });

  // ----------------------------------------------------------------
  // Create-Rollback: SshConnection insert fails → secrets rolled back
  // ----------------------------------------------------------------
  await check('create() rolls back inline secrets when SshConnection insert fails', async () => {
    const { svc, sshModel, secretModel } = newWorld();

    // First create a connection that takes slug "boom".
    await svc.create(
      {
        label: 'boom-pre',
        slug: 'boom',
        customerId,
        host: 'h',
        username: 'u',
        authMethod: 'password',
        inlineSecrets: { password: { password: 'pw' } },
      },
      userId,
    );

    // Second create on the same slug+scope must fail at the SshConnection
    // insert step (duplicate key). The freshly created secrets for this
    // attempt must be rolled back.
    const secretCountBefore = secretModel._store.size;
    await assert.rejects(
      () =>
        svc.create(
          {
            label: 'boom-dup',
            slug: 'boom',
            customerId,
            host: 'h',
            username: 'u',
            authMethod: 'key',
            inlineSecrets: { key: { privateKey: 'KEY', passphrase: 'PP' } },
          },
          userId,
        ),
      /already exists/,
    );

    // Connection count unchanged.
    assert.equal(sshModel._store.size, 1, 'only the pre-existing connection survives');
    // Secret count must be EXACTLY the same as before the failing attempt.
    assert.equal(
      secretModel._store.size,
      secretCountBefore,
      `secrets rolled back (expected ${secretCountBefore}, got ${secretModel._store.size})`,
    );
  });

  await check('create() rolls back when SecretsService throws mid-stream', async () => {
    const { svc, secretsService, secretModel, sshModel } = newWorld();

    // First inline-key create succeeds → 1 connection + 2 secrets.
    await svc.create(
      {
        label: 'ok',
        slug: 'ok',
        customerId,
        host: 'h',
        username: 'u',
        authMethod: 'key',
        inlineSecrets: { key: { privateKey: 'pem', passphrase: 'pp' } },
      },
      userId,
    );

    const beforeSecrets = secretModel._store.size;
    const beforeConns = sshModel._store.size;

    // For the next call: SecretsService throws on its very first invocation
    // (which is the `ssh:fail:privatekey` create). No secret should remain.
    secretsService.failNextCreate();
    await assert.rejects(
      () =>
        svc.create(
          {
            label: 'fail',
            slug: 'fail',
            customerId,
            host: 'h',
            username: 'u',
            authMethod: 'key',
            inlineSecrets: { key: { privateKey: 'pem', passphrase: 'pp' } },
          },
          userId,
        ),
      /synthetic SecretsService\.create failure/,
    );

    assert.equal(secretModel._store.size, beforeSecrets, 'no orphan secrets');
    assert.equal(sshModel._store.size, beforeConns, 'no orphan connections');
  });

  // ----------------------------------------------------------------
  // Status setters
  // ----------------------------------------------------------------
  await check('recordConnectError + recordConnectSuccess toggle status fields', async () => {
    const { svc } = newWorld();
    const conn = await svc.create(
      {
        label: 's1',
        slug: 's1',
        projectId,
        host: 'h',
        username: 'u',
        authMethod: 'password',
        inlineSecrets: { password: { password: 'pw' } },
      },
      userId,
    );

    const afterErr = await svc.recordConnectError(String(conn._id), 'auth failed');
    assert.equal(afterErr.lastConnectError.message, 'auth failed');
    assert.ok(afterErr.lastConnectError.at instanceof Date);

    const afterOk = await svc.recordConnectSuccess(String(conn._id));
    assert.ok(afterOk.lastConnectedAt instanceof Date);
    assert.equal(afterOk.lastConnectError, undefined);
  });

  await check('setKnownHostFingerprint persists the SHA256 string', async () => {
    const { svc } = newWorld();
    const conn = await svc.create(
      {
        label: 'fp',
        slug: 'fp',
        projectId,
        host: 'h',
        username: 'u',
        authMethod: 'password',
        inlineSecrets: { password: { password: 'pw' } },
      },
      userId,
    );
    const fp = 'SHA256:abcdef0123456789';
    const out = await svc.setKnownHostFingerprint(String(conn._id), fp);
    assert.equal(out.knownHostFingerprint, fp);
  });

  // ----------------------------------------------------------------
  // findById / list helpers
  // ----------------------------------------------------------------
  await check('findByCustomerId / findByProjectId return only matching docs', async () => {
    const { svc } = newWorld();
    await svc.create(
      {
        label: 'a',
        slug: 'a',
        customerId,
        host: 'h',
        username: 'u',
        authMethod: 'password',
        inlineSecrets: { password: { password: 'pw' } },
      },
      userId,
    );
    await svc.create(
      {
        label: 'b',
        slug: 'b',
        projectId,
        host: 'h',
        username: 'u',
        authMethod: 'password',
        inlineSecrets: { password: { password: 'pw' } },
      },
      userId,
    );

    const forCustomer = await svc.findByCustomerId(customerId);
    const forProject = await svc.findByProjectId(projectId);
    assert.equal(forCustomer.length, 1);
    assert.equal(forCustomer[0].label, 'a');
    assert.equal(forProject.length, 1);
    assert.equal(forProject[0].label, 'b');
  });

  await check('findById throws NotFoundException for missing id', async () => {
    const { svc } = newWorld();
    await assert.rejects(
      () => svc.findById(new Types.ObjectId().toString()),
      /not found/i,
    );
  });

  // ----------------------------------------------------------------
  // update(): metadata-only patch leaves secrets alone
  // ----------------------------------------------------------------
  await check('update() with metadata-only patch does not touch secrets', async () => {
    const { svc, secretModel } = newWorld();
    const conn = await svc.create(
      {
        label: 'meta',
        slug: 'meta',
        customerId,
        host: 'old-host',
        username: 'u',
        authMethod: 'key',
        inlineSecrets: { key: { privateKey: 'PEM', passphrase: 'pp' } },
      },
      userId,
    );
    const origPk = String(conn.privateKeySecretId);
    const origPp = String(conn.passphraseSecretId);
    const secretsBefore = secretModel._store.size;

    const updated = await svc.update(String(conn._id), {
      label: 'meta-renamed',
      host: 'new-host',
      port: 2200,
    });

    assert.equal(updated.label, 'meta-renamed');
    assert.equal(updated.host, 'new-host');
    assert.equal(updated.port, 2200);
    // Refs unchanged.
    assert.equal(String(updated.privateKeySecretId), origPk);
    assert.equal(String(updated.passphraseSecretId), origPp);
    // Secrets store untouched (no rotation).
    assert.equal(secretModel._store.size, secretsBefore);
    // __v incremented exactly once.
    assert.equal(updated.__v, 1);
  });

  // ----------------------------------------------------------------
  // update(): credential rotation deletes old owned secrets, creates new
  // ones with ownedBy stamp, even when reusing the same key-naming pattern
  // (verifies Critical #2 fix — delete-first-then-create).
  // ----------------------------------------------------------------
  await check('update() with credential rotation swaps owned secrets without key collision', async () => {
    const { svc, secretModel } = newWorld();
    const conn = await svc.create(
      {
        label: 'rotate',
        slug: 'rotate',
        customerId,
        host: 'h',
        username: 'u',
        authMethod: 'key',
        inlineSecrets: { key: { privateKey: 'OLD-PEM', passphrase: 'OLD-PP' } },
      },
      userId,
    );
    const oldPk = String(conn.privateKeySecretId);
    const oldPp = String(conn.passphraseSecretId);
    // Sanity: 2 owned secrets exist.
    assert.equal(secretModel._store.size, 2);
    assert.equal(String(secretModel._store.get(oldPk).ownedBySshConnectionId), String(conn._id));

    const rotated = await svc.update(String(conn._id), {
      inlineSecrets: { key: { privateKey: 'NEW-PEM', passphrase: 'NEW-PP' } },
    });

    // Old owned secrets are gone (verifies Critical #2: same key reused).
    assert.equal(secretModel._store.has(oldPk), false, 'old privatekey secret deleted');
    assert.equal(secretModel._store.has(oldPp), false, 'old passphrase secret deleted');

    // Refs point at NEW ids.
    const newPk = String(rotated.privateKeySecretId);
    const newPp = String(rotated.passphraseSecretId);
    assert.notEqual(newPk, oldPk);
    assert.notEqual(newPp, oldPp);

    // New secrets carry the ownership stamp.
    const newPkDoc = secretModel._store.get(newPk);
    const newPpDoc = secretModel._store.get(newPp);
    assert.ok(newPkDoc, 'new privatekey persisted');
    assert.ok(newPpDoc, 'new passphrase persisted');
    assert.equal(String(newPkDoc.ownedBySshConnectionId), String(conn._id));
    assert.equal(String(newPpDoc.ownedBySshConnectionId), String(conn._id));
    // Encrypted values reflect the rotation.
    assert.equal(newPkDoc.encryptedValue, 'enc:NEW-PEM');
    assert.equal(newPpDoc.encryptedValue, 'enc:NEW-PP');
    // Store still holds exactly 2 owned secrets (no orphans).
    assert.equal(secretModel._store.size, 2);
    // __v incremented.
    assert.equal(rotated.__v, 1);
  });

  // ----------------------------------------------------------------
  // update(): credential rotation dropping the passphrase
  // ----------------------------------------------------------------
  await check('update() rotation without passphrase deletes the previous passphrase secret', async () => {
    const { svc, secretModel } = newWorld();
    const conn = await svc.create(
      {
        label: 'pp-drop',
        slug: 'pp-drop',
        customerId,
        host: 'h',
        username: 'u',
        authMethod: 'key',
        inlineSecrets: { key: { privateKey: 'OLD', passphrase: 'gone' } },
      },
      userId,
    );
    assert.equal(secretModel._store.size, 2);
    const oldPp = String(conn.passphraseSecretId);

    const rotated = await svc.update(String(conn._id), {
      inlineSecrets: { key: { privateKey: 'NEW' /* no passphrase */ } },
    });

    assert.equal(rotated.passphraseSecretId, undefined, 'passphrase ref cleared');
    assert.equal(secretModel._store.has(oldPp), false, 'old passphrase secret cascade-deleted');
    assert.equal(secretModel._store.size, 1, 'only the new privatekey survives');
  });

  // ----------------------------------------------------------------
  // update(): concurrent-write detection (Critical #1) — __v changed
  // between findById() and findOneAndUpdate() → ConflictException AND
  // freshly created secrets are rolled back.
  // ----------------------------------------------------------------
  await check('update() rejects concurrent write via __v guard and rolls back new secrets', async () => {
    const { svc, sshModel, secretModel } = newWorld();
    const conn = await svc.create(
      {
        label: 'race',
        slug: 'race',
        customerId,
        host: 'h',
        username: 'u',
        authMethod: 'key',
        inlineSecrets: { key: { privateKey: 'PEM' } },
      },
      userId,
    );
    const oldPk = String(conn.privateKeySecretId);

    // Hook into the model: bump __v on the doc right before SshService's
    // own findOneAndUpdate runs, simulating a concurrent writer that
    // committed in between our findById() snapshot and our update.
    const origFindOneAndUpdate = sshModel.findOneAndUpdate.bind(sshModel);
    let triggered = false;
    sshModel.findOneAndUpdate = (filter, update, opts) => {
      if (!triggered && filter && filter.__v !== undefined) {
        triggered = true;
        // Simulate "someone else just wrote".
        const stored = sshModel._store.get(String(filter._id));
        if (stored) stored.__v = (stored.__v || 0) + 1;
      }
      return origFindOneAndUpdate(filter, update, opts);
    };

    const secretsBeforeAttempt = secretModel._store.size;

    await assert.rejects(
      () =>
        svc.update(String(conn._id), {
          inlineSecrets: { key: { privateKey: 'NEW-PEM' } },
        }),
      /modified by another request/i,
    );

    // The brand-new secret from this losing attempt must be rolled back.
    // Owned-secret count: old privatekey was deleted-first, then a new
    // one was created, then conflict detected → rolled back. Net: 0
    // owned secrets remain in store (old gone, new gone).
    // Pre-rotation we had 1 owned secret; that has been delete-first'd
    // and the new one was rolled back ⇒ store is now empty for secrets.
    assert.equal(
      secretModel._store.size,
      secretsBeforeAttempt - 1,
      'old owned secret was deleted; new owned secret rolled back; net -1',
    );
    // Note: the original `oldPk` is irrecoverable here. That's an
    // acceptable trade-off — the rotation lost a race and the rotator
    // must retry with the fresh credential material. We don't persist
    // plaintext to "undo" deletions.
    assert.equal(secretModel._store.has(oldPk), false, 'old secret was delete-first');

    // The connection itself is unchanged (in-memory `doc` refs were
    // restored by the catch block; on disk nothing was written either).
    const stored = sshModel._store.get(String(conn._id));
    assert.equal(String(stored.privateKeySecretId), oldPk, 'stored ref untouched by losing writer');
  });

  // ----------------------------------------------------------------
  // Summary
  // ----------------------------------------------------------------
  console.log('');
  console.log(`SSH service unit checks: ${total - failures}/${total} passed`);
  if (failures > 0) process.exit(1);
})();
