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
  const secretsService = makeSecretsServiceWith(secretModel);
  const svc = new SshService(sshModel, secretModel, secretsService);
  return { svc, sshModel, secretModel, secretsService };
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
  // Summary
  // ----------------------------------------------------------------
  console.log('');
  console.log(`SSH service unit checks: ${total - failures}/${total} passed`);
  if (failures > 0) process.exit(1);
})();
