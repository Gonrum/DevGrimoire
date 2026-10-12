#!/usr/bin/env node
/*
 * SSH-Scope-Check (Review-Funde C-5 und H-32, 2026-10-12).
 *
 * C-5: `grep -rn "RequestContext|actorCan|ForbiddenException" backend/src/ssh/`
 * lieferte NULL Treffer. Jede SSH-Route war über eine erratene Id erreichbar,
 * und die Kette PATCH host -> test -> accept-fingerprint -> test liess das
 * Backend die entschlüsselten Credentials gegen einen fremden Host benutzen.
 *
 * Belegt hier:
 *   - findById / findBySlug / Listen respektieren Projekt- UND Kunden-Achse
 *   - update/delete lehnen VOR der Mutation ab (Zähler bleibt 0)
 *   - create in fremden Scope und mit fremdem Pick-Existing-Secret wird abgelehnt
 *   - eine host-/port-Änderung setzt den TOFU-Fingerprint zurück, eine
 *     unveränderte nicht
 *   - Job-Status/-Cancel prüfen den Scope der Verbindung
 *
 * H-32: ein fehlgeschlagener ssh_exec_async gab den Concurrency-Slot zweimal
 * frei (finally + .catch). Belegt über einen gehaltenen Slot, der danach noch
 * gezählt sein muss.
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { RequestContext } = loadCompiled('common/request-context.js');
const { SshService } = loadCompiled('ssh/ssh.service.js');
const { SshSessionService } = loadCompiled('ssh/ssh-session.service.js');
const mongoose = loadCompiled('../node_modules/mongoose/index.js');
const { Types } = mongoose;

const EXPECTED_CHECKS = 13;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const OWN_PROJECT = new Types.ObjectId();
const FOREIGN_PROJECT = new Types.ObjectId();
const OWN_CUSTOMER = new Types.ObjectId();
const FOREIGN_CUSTOMER = new Types.ObjectId();

function asScopedActor(fn) {
  return RequestContext.run({
    userId: 'u-scoped', username: 'scoped', role: 'user',
    projectScopeMode: 'allowlist', allowedProjectIds: [String(OWN_PROJECT)],
    customerScopeMode: 'allowlist', allowedCustomerIds: [String(OWN_CUSTOMER)],
  }, undefined, fn);
}

/** Projekt-Achse offen, Kunden-Achse verengt. */
function asWideProjectActor(fn) {
  return RequestContext.run({
    userId: 'u-wide', username: 'wide', role: 'user',
    projectScopeMode: 'all',
    customerScopeMode: 'allowlist', allowedCustomerIds: [String(OWN_CUSTOMER)],
  }, undefined, fn);
}

async function expect403(fn) {
  await assert.rejects(fn, (err) => {
    assert.equal(err.status ?? err.getStatus?.(), 403, `erwartet 403, war ${err.message}`);
    return true;
  });
}

const chain = (value) => ({
  select: () => chain(value),
  sort: () => chain(value),
  lean: () => chain(value),
  exec: async () => value,
});

function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.$in) {
      return v.$in.map(String).includes(String(doc[k]));
    }
    return String(doc[k]) === String(v);
  });
}

function makeFixture() {
  const counter = { writes: 0, deletes: 0, creates: 0 };
  const updates = [];
  const conn = (label, scope) => ({
    _id: new Types.ObjectId(), label, slug: label, host: `${label}.internal`, port: 22,
    username: 'deploy', authMethod: 'key', tags: [], knownHostFingerprint: 'SHA256:known',
    __v: 0, ...scope,
  });
  const own = conn('own', { projectId: OWN_PROJECT });
  const foreign = conn('foreign', { projectId: FOREIGN_PROJECT });
  const ownCust = conn('own-cust', { customerId: OWN_CUSTOMER });
  const foreignCust = conn('foreign-cust', { customerId: FOREIGN_CUSTOMER });
  const conns = [own, foreign, ownCust, foreignCust];

  const foreignSecret = { _id: new Types.ObjectId(), projectId: FOREIGN_PROJECT };
  const ownSecret = { _id: new Types.ObjectId(), projectId: OWN_PROJECT };
  const secrets = [foreignSecret, ownSecret];

  const sshModel = {
    findById: (id) => chain(conns.find((c) => String(c._id) === String(id)) ?? null),
    findOne: (f) => chain(conns.find((c) => matches(c, f)) ?? null),
    find: (f) => chain(conns.filter((c) => matches(c, f))),
    findOneAndUpdate: (f, upd) => ({
      exec: async () => {
        const doc = conns.find((c) => String(c._id) === String(f._id));
        if (!doc) return null;
        counter.writes += 1;
        updates.push(upd);
        Object.assign(doc, upd.$set);
        return doc;
      },
    }),
    deleteOne: () => ({ exec: async () => { counter.deletes += 1; return { deletedCount: 1 }; } }),
    create: async (d) => { counter.creates += 1; return { _id: new Types.ObjectId(), ...d }; },
  };
  const secretModel = {
    find: (f) => chain(secrets.filter((s) => matches(s, f))),
    deleteMany: () => ({ exec: async () => { counter.deletes += 1; return { deletedCount: 0 }; } }),
    updateMany: () => ({ exec: async () => ({}) }),
  };
  // Projekt OWN ist mit dem fremden Kunden verlinkt — dessen Server sind „geerbt".
  const linkModel = {
    find: () => chain([{ customerId: FOREIGN_CUSTOMER }]),
  };
  const svc = new SshService(
    sshModel, secretModel, {}, {}, { emit() {} }, linkModel,
  );
  return { svc, counter, updates, own, foreign, ownCust, foreignCust, foreignSecret, ownSecret };
}

const createDto = (scope, extra = {}) => ({
  label: 'neu', slug: 'neu', host: 'h', username: 'u', authMethod: 'key',
  privateKeySecretId: undefined, ...scope, ...extra,
});

(async () => {
  await check('findById: fremdes Projekt -> 403, eigenes Projekt -> ok', async () => {
    const f = makeFixture();
    await asScopedActor(async () => {
      await expect403(() => f.svc.findById(String(f.foreign._id)));
      const doc = await f.svc.findById(String(f.own._id));
      assert.equal(doc.label, 'own');
    });
  });

  await check('findById: kunden-gebundene Verbindung prüft die KUNDEN-Achse, nicht die Projekt-Achse', async () => {
    const f = makeFixture();
    await asWideProjectActor(async () => {
      await expect403(() => f.svc.findById(String(f.foreignCust._id)));
      const doc = await f.svc.findById(String(f.ownCust._id));
      assert.equal(doc.label, 'own-cust');
    });
  });

  await check('findById: ohne Actor (interner Aufrufer) bleibt ungegated', async () => {
    const f = makeFixture();
    const doc = await f.svc.findById(String(f.foreign._id));
    assert.equal(doc.label, 'foreign');
  });

  await check('findByProjectId: geerbte Verbindung eines fremden Kunden wird ausgefiltert', async () => {
    const f = makeFixture();
    const labels = await asScopedActor(async () =>
      (await f.svc.findByProjectId(String(OWN_PROJECT))).map((d) => d.label));
    assert.deepEqual(labels, ['own']);
    // Gegenprobe ohne Actor: dieselbe Abfrage liefert die geerbte Verbindung.
    const all = (await f.svc.findByProjectId(String(OWN_PROJECT))).map((d) => d.label);
    assert.deepEqual(all, ['own', 'foreign-cust']);
  });

  await check('findByCustomerId / findByScopeAndTags: fremder Kunde liefert nichts', async () => {
    const f = makeFixture();
    await asScopedActor(async () => {
      assert.deepEqual(await f.svc.findByCustomerId(String(FOREIGN_CUSTOMER)), []);
      assert.deepEqual(await f.svc.findByScopeAndTags({ customerId: String(FOREIGN_CUSTOMER) }), []);
      assert.equal((await f.svc.findByCustomerId(String(OWN_CUSTOMER))).length, 1);
    });
  });

  await check('findBySlug: Scope kommt vom Aufrufer -> fremdes Projekt 403', async () => {
    const f = makeFixture();
    await asScopedActor(async () => {
      await expect403(() => f.svc.findBySlug('foreign', { projectId: String(FOREIGN_PROJECT) }));
    });
  });

  await check('update/delete/accept-fingerprint auf fremde Verbindung: 403 und KEINE Mutation', async () => {
    const f = makeFixture();
    await asScopedActor(async () => {
      await expect403(() => f.svc.update(String(f.foreign._id), { host: 'attacker.tld' }));
      await expect403(() => f.svc.delete(String(f.foreign._id)));
      await expect403(() => f.svc.setKnownHostFingerprint(String(f.foreign._id), 'SHA256:evil'));
    });
    assert.deepEqual(f.counter, { writes: 0, deletes: 0, creates: 0 });
    assert.equal(f.foreign.host, 'foreign.internal');
    assert.equal(f.foreign.knownHostFingerprint, 'SHA256:known');
  });

  await check('create in fremdes Projekt / fremden Kunden: 403, kein Insert', async () => {
    const f = makeFixture();
    await asScopedActor(async () => {
      await expect403(() => f.svc.create(
        createDto({ projectId: String(FOREIGN_PROJECT) }, { privateKeySecretId: String(f.ownSecret._id) }), 'u'));
      await expect403(() => f.svc.create(
        createDto({ customerId: String(FOREIGN_CUSTOMER) }, { privateKeySecretId: String(f.ownSecret._id) }), 'u'));
    });
    assert.equal(f.counter.creates, 0);
  });

  await check('create im eigenen Projekt mit FREMDEM Pick-Existing-Key: 403, kein Insert', async () => {
    const f = makeFixture();
    await asScopedActor(async () => {
      await expect403(() => f.svc.create(
        createDto({ projectId: String(OWN_PROJECT) }, { privateKeySecretId: String(f.foreignSecret._id) }), 'u'));
      // Positivfall: eigener Key geht durch.
      await f.svc.create(
        createDto({ projectId: String(OWN_PROJECT) }, { privateKeySecretId: String(f.ownSecret._id) }), 'u');
    });
    assert.equal(f.counter.creates, 1);
  });

  await check('update: Pick-Rotation auf fremden Key -> 403, keine Mutation', async () => {
    const f = makeFixture();
    await asScopedActor(async () => {
      await expect403(() => f.svc.update(String(f.own._id), { privateKeySecretId: String(f.foreignSecret._id) }));
    });
    assert.equal(f.counter.writes, 0);
  });

  await check('update: host-Änderung setzt den TOFU-Fingerprint zurück, gleicher host nicht', async () => {
    const f = makeFixture();
    await asScopedActor(async () => {
      await f.svc.update(String(f.own._id), { host: 'own.internal', label: 'x' });
      await f.svc.update(String(f.own._id), { host: 'new.internal' });
      await f.svc.update(String(f.own._id), { port: 2222 });
    });
    assert.equal(f.updates.length, 3);
    assert.equal(f.updates[0].$unset, undefined, 'unveränderter host darf TOFU nicht zurücksetzen');
    assert.deepEqual(f.updates[1].$unset, { knownHostFingerprint: 1 });
    assert.deepEqual(f.updates[2].$unset, { knownHostFingerprint: 1 });
  });

  // ---- SshSessionService ----------------------------------------------------

  function makeSession(sshService) {
    const audit = { create: async () => ({}) };
    return new SshSessionService(sshService, {}, audit, {}, { get: async () => null });
  }

  await check('getJobStatus/cancelJob: fremde Verbindung -> 403', async () => {
    const f = makeFixture();
    const session = makeSession(f.svc);
    session.execJobs.set('ssh-job-x', {
      jobId: 'ssh-job-x', connectionId: String(f.foreign._id), command: 'id', wrappedCommand: 'id',
      startedAt: Date.now(), sourceContext: 'mcp', state: 'running', stdoutBytes: 0, stderrBytes: 0,
      lastChunkAt: null, stdoutTail: [], stdoutTailBytes: 0, stderrTail: [], stderrTailBytes: 0, exitCode: null,
    });
    await asScopedActor(async () => {
      await expect403(() => session.getJobStatus('ssh-job-x'));
      await expect403(() => session.cancelJob('ssh-job-x'));
    });
    const snap = await session.getJobStatus('ssh-job-x');
    assert.equal(snap.jobId, 'ssh-job-x');
  });

  await check('H-32: fehlgeschlagener ssh_exec_async gibt seinen Slot genau EINMAL frei', async () => {
    const connId = String(new Types.ObjectId());
    const failing = {
      findById: async () => { throw new Error('credential_missing'); },
      recordConnectError: async () => {},
    };
    const session = makeSession(failing);
    // Ein zweiter, noch laufender Exec hält einen Slot.
    await session.acquireSlot(connId);
    assert.equal(session.concurrency.get(connId).active, 1);
    await session.execAsync(connId, 'false');
    // Background-Task abwarten.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const state = session.concurrency.get(connId);
    assert.ok(state, 'State wurde gelöscht — der gehaltene Slot ging verloren (Doppel-Release)');
    assert.equal(state.active, 1, `active=${state.active}, erwartet 1`);
    for (const job of session.execJobs.values()) {
      assert.equal(job.state, 'aborted');
      if (job.ttlTimer) clearTimeout(job.ttlTimer);
    }
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
