#!/usr/bin/env node
/*
 * http-requests Scope-Check (Review-Fund C-14, 2026-10-11).
 *
 * `http-requests.service.ts` importierte vorher weder `RequestContext` noch
 * `common/permissions` (grep: 0 Treffer), während acht andere Module das
 * T-210-Scope-Modell durchziehen. Gleichzeitig speichert `SavedRequest.auth`
 * Basic-Auth-Passwörter und Bearer-Tokens ALS KLARTEXT — nackte @Prop()-Strings
 * ohne EncryptionService. `replication-collections.ts` schliesst die
 * Collection ausdrücklich aus der Replikation aus und begründet das mit genau
 * dieser Klartext-Speicherung; gelesen werden durfte sie trotzdem von jedem.
 *
 * Dieser Check belegt, dass ein verengter Actor fremde Requests weder lesen,
 * ändern, löschen noch absenden kann — und dass die Schreib-/Kaskadenpfade die
 * Prüfung VOR der Mutation ausführen.
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

const { HttpRequestsService } = loadCompiled('http-requests/http-requests.service.js');
const { RequestContext } = loadCompiled('common/request-context.js');
const { UserRole } = loadCompiled('auth/schemas/user.schema.js');
const mongoose = loadCompiled('../node_modules/mongoose/index.js');
const { Types } = mongoose;

const EXPECTED_CHECKS = 10;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

/** Actor mit explizit verengtem Projekt-Scope — die Konfiguration, um die es geht. */
function asScopedActor(allowedProjectIds, fn) {
  return RequestContext.run({
    userId: 'u-scoped', username: 'scoped', role: 'user',
    projectScopeMode: 'allowlist', allowedProjectIds,
    customerScopeMode: 'allowlist', allowedCustomerIds: [],
  }, undefined, fn);
}

/**
 * In-Memory-Modell mit den Ketten, die der Service benutzt
 * (`find().sort().exec()`, `find().distinct().exec()`, `findById().exec()`).
 * `mutations` zählt Schreibzugriffe, damit ein abgelehnter Aufruf nicht nur
 * „wirft", sondern nachweislich NICHTS geändert hat.
 */
function makeModel(docs, counter) {
  const store = new Map(docs.map((d) => [String(d._id), { ...d }]));
  const wrap = (rows) => ({
    sort: () => wrap(rows),
    skip: () => wrap(rows),
    limit: () => wrap(rows),
    distinct: (field) => ({ exec: async () => rows.map((r) => r[field]) }),
    exec: async () => rows,
  });
  return {
    _store: store,
    findById(id) {
      return { exec: async () => store.get(String(id)) ?? null };
    },
    find(filter) {
      const rows = [...store.values()].filter((d) => Object.entries(filter).every(([k, v]) => {
        if (v && typeof v === 'object' && v.$in) return v.$in.map(String).includes(String(d[k]));
        return String(d[k]) === String(v);
      }));
      return wrap(rows);
    },
    async create(doc) {
      counter.writes += 1;
      const _id = doc._id || new Types.ObjectId();
      const saved = { _id, ...doc };
      store.set(String(_id), saved);
      return saved;
    },
    findByIdAndUpdate(id, update) {
      return {
        exec: async () => {
          counter.writes += 1;
          const doc = store.get(String(id));
          if (!doc) return null;
          Object.assign(doc, update.$set ?? {});
          return doc;
        },
      };
    },
    findByIdAndDelete(id) {
      return {
        exec: async () => {
          const doc = store.get(String(id));
          if (!doc) return null;
          counter.deletes += 1;
          store.delete(String(id));
          return doc;
        },
      };
    },
    deleteMany(filter) {
      return {
        exec: async () => {
          let n = 0;
          for (const key of [...store.keys()]) {
            const d = store.get(key);
            const hit = Object.entries(filter).every(([k, v]) => {
              if (v && typeof v === 'object' && v.$in) return v.$in.map(String).includes(String(d[k]));
              return String(d[k]) === String(v);
            });
            if (hit) { store.delete(key); n += 1; }
          }
          counter.deletes += n;
          return { deletedCount: n };
        },
      };
    },
  };
}

const OWN_PROJECT = new Types.ObjectId();
const FOREIGN_PROJECT = new Types.ObjectId();
const COLLECTION_OWN = new Types.ObjectId();
const COLLECTION_FOREIGN = new Types.ObjectId();
const REQUEST_OWN = new Types.ObjectId();
const REQUEST_FOREIGN = new Types.ObjectId();
const HISTORY_FOREIGN = new Types.ObjectId();

/** Klartext-Credentials, wie sie das Schema tatsächlich speichert. */
const FOREIGN_SECRET_VALUE = 'geheimes-bearer-token-aus-fremdem-projekt';

function buildFixture() {
  const counter = { writes: 0, deletes: 0 };
  const collectionModel = makeModel([
    { _id: COLLECTION_OWN, projectId: OWN_PROJECT, name: 'own', order: 0 },
    { _id: COLLECTION_FOREIGN, projectId: FOREIGN_PROJECT, name: 'foreign', order: 0 },
  ], counter);
  const requestModel = makeModel([
    {
      _id: REQUEST_OWN, projectId: OWN_PROJECT, collectionId: COLLECTION_OWN,
      name: 'own request', method: 'GET', url: 'https://example.test/own',
    },
    {
      _id: REQUEST_FOREIGN, projectId: FOREIGN_PROJECT, collectionId: COLLECTION_FOREIGN,
      name: 'foreign request', method: 'GET', url: 'https://example.test/foreign',
      auth: { type: 'bearer', token: FOREIGN_SECRET_VALUE },
    },
  ], counter);
  const historyModel = makeModel([
    {
      _id: HISTORY_FOREIGN, requestId: REQUEST_FOREIGN, projectId: FOREIGN_PROJECT,
      sentAt: new Date(), responseBody: 'fremder Response-Body',
    },
  ], counter);
  const svc = new HttpRequestsService(
    collectionModel, requestModel, historyModel,
    { findById: async () => null }, { findById: async () => null },
  );
  return { svc, collectionModel, requestModel, historyModel, counter };
}

(async () => {
  await check('getRequest verweigert einen fremden Request (403) und liefert kein Klartext-Token', async () => {
    const fx = buildFixture();
    await asScopedActor([String(OWN_PROJECT)], async () => {
      const err = await fx.svc.getRequest(String(REQUEST_FOREIGN)).then(() => null, (e) => e);
      assert.ok(err, 'ein verengter Actor hätte den fremden Request nicht lesen dürfen');
      assert.equal(err.getStatus(), 403, `erwartet 403, bekam ${err.getStatus()}`);
      // Der Token darf in keiner Fehlermeldung auftauchen.
      assert.ok(!String(err.message).includes(FOREIGN_SECRET_VALUE),
        'der Klartext-Token steht in der Fehlermeldung');
      assert.ok(!String(err.message).includes(String(FOREIGN_PROJECT)),
        'die Absage leakt die fremde Projekt-Id');
      // Der eigene Request bleibt erreichbar — sonst wäre es kein Scope.
      const own = await fx.svc.getRequest(String(REQUEST_OWN));
      assert.equal(own.name, 'own request');
    });
  });

  await check('updateRequest verweigert UND schreibt nicht', async () => {
    const fx = buildFixture();
    const before = JSON.stringify(fx.requestModel._store.get(String(REQUEST_FOREIGN)));
    await asScopedActor([String(OWN_PROJECT)], async () => {
      const err = await fx.svc
        .updateRequest(String(REQUEST_FOREIGN), { name: 'umbenannt', url: 'https://evil.test' })
        .then(() => null, (e) => e);
      assert.ok(err, 'updateRequest hätte ablehnen müssen');
      assert.equal(err.getStatus(), 403);
    });
    assert.equal(fx.counter.writes, 0,
      `es wurde geschrieben (${fx.counter.writes}x) — die Prüfung läuft nach der Mutation`);
    assert.equal(JSON.stringify(fx.requestModel._store.get(String(REQUEST_FOREIGN))), before,
      'der fremde Request wurde verändert');
  });

  await check('deleteRequest verweigert UND löscht weder Request noch History', async () => {
    const fx = buildFixture();
    await asScopedActor([String(OWN_PROJECT)], async () => {
      const err = await fx.svc.deleteRequest(String(REQUEST_FOREIGN)).then(() => null, (e) => e);
      assert.ok(err, 'deleteRequest hätte ablehnen müssen');
      assert.equal(err.getStatus(), 403);
    });
    assert.equal(fx.counter.deletes, 0, `es wurde gelöscht (${fx.counter.deletes}x)`);
    assert.equal(fx.requestModel._store.has(String(REQUEST_FOREIGN)), true, 'der Request ist weg');
    assert.equal(fx.historyModel._store.has(String(HISTORY_FOREIGN)), true,
      'die History-Kaskade lief trotz Ablehnung');
  });

  await check('listRequests filtert fremde Requests über collectionId heraus', async () => {
    const fx = buildFixture();
    await asScopedActor([String(OWN_PROJECT)], async () => {
      // `collectionId` kommt vom Aufrufer und ist kein Berechtigungsnachweis.
      const foreign = await fx.svc.listRequests({ collectionId: String(COLLECTION_FOREIGN) });
      assert.equal(foreign.length, 0,
        `fremde Requests wurden aufgelistet: ${foreign.map((r) => r.name).join(', ')}`);
      const own = await fx.svc.listRequests({ collectionId: String(COLLECTION_OWN) });
      assert.equal(own.length, 1, 'der eigene Request fehlt');
      // Und über die Projekt-Achse dasselbe Bild.
      const byProject = await fx.svc.listRequests({ projectId: String(FOREIGN_PROJECT) });
      assert.equal(byProject.length, 0, 'die Query-String-Enumeration über projectId ist offen');
    });
  });

  await check('listHistory verweigert über den Eltern-Request', async () => {
    const fx = buildFixture();
    await asScopedActor([String(OWN_PROJECT)], async () => {
      const err = await fx.svc.listHistory(String(REQUEST_FOREIGN)).then(() => null, (e) => e);
      assert.ok(err, 'listHistory hätte ablehnen müssen — die Einträge tragen den vollen Response-Body');
      assert.equal(err.getStatus(), 403);
    });
  });

  await check('getHistoryEntry verweigert über den Eltern-Request, nicht über das optionale projectId', async () => {
    const fx = buildFixture();
    await asScopedActor([String(OWN_PROJECT)], async () => {
      const err = await fx.svc.getHistoryEntry(String(HISTORY_FOREIGN)).then(() => null, (e) => e);
      assert.ok(err, 'getHistoryEntry hätte ablehnen müssen');
      assert.equal(err.getStatus(), 403);
    });
    // Der Eltern-Pfad muss auch dann greifen, wenn der Eintrag selbst kein
    // projectId trägt (ältere Einträge) — sonst wäre die Prüfung löchrig.
    const fx2 = buildFixture();
    delete fx2.historyModel._store.get(String(HISTORY_FOREIGN)).projectId;
    await asScopedActor([String(OWN_PROJECT)], async () => {
      const err = await fx2.svc.getHistoryEntry(String(HISTORY_FOREIGN)).then(() => null, (e) => e);
      assert.ok(err, 'ohne projectId am Eintrag war die Prüfung umgehbar');
      assert.equal(err.getStatus(), 403);
    });
  });

  await check('deleteCollection verweigert UND kaskadiert nicht', async () => {
    const fx = buildFixture();
    await asScopedActor([String(OWN_PROJECT)], async () => {
      const err = await fx.svc.deleteCollection(String(COLLECTION_FOREIGN)).then(() => null, (e) => e);
      assert.ok(err, 'deleteCollection hätte ablehnen müssen');
      assert.equal(err.getStatus(), 403);
    });
    assert.equal(fx.counter.deletes, 0,
      `die Kaskade lief (${fx.counter.deletes} Löschungen) — Collection, Requests und History wären weg`);
    assert.equal(fx.collectionModel._store.has(String(COLLECTION_FOREIGN)), true);
    assert.equal(fx.requestModel._store.has(String(REQUEST_FOREIGN)), true);
  });

  await check('updateCollection und createCollection/createRequest prüfen ebenfalls', async () => {
    const fx = buildFixture();
    await asScopedActor([String(OWN_PROJECT)], async () => {
      const upd = await fx.svc.updateCollection(String(COLLECTION_FOREIGN), { name: 'x' })
        .then(() => null, (e) => e);
      assert.ok(upd && upd.getStatus() === 403, 'updateCollection war ungeprüft');

      const createCol = await fx.svc.createCollection({ projectId: String(FOREIGN_PROJECT), name: 'neu' })
        .then(() => null, (e) => e);
      assert.ok(createCol && createCol.getStatus() === 403,
        'createCollection erlaubte das Anlegen in einem fremden Projekt');

      const createReq = await fx.svc.createRequest({ collectionId: String(COLLECTION_FOREIGN), name: 'neu', method: 'GET', url: 'https://x.test' })
        .then(() => null, (e) => e);
      assert.ok(createReq && createReq.getStatus() === 403,
        'createRequest erlaubte das Anlegen in einer fremden Collection');
    });
    assert.equal(fx.counter.writes, 0, `trotz Ablehnung wurde geschrieben (${fx.counter.writes}x)`);
  });

  await check('kein Actor (interner Aufrufer / Replikation) bleibt ungegated', async () => {
    const fx = buildFixture();
    assert.equal(RequestContext.getUser(), undefined, 'Testannahme: kein Actor gesetzt');
    const doc = await fx.svc.getRequest(String(REQUEST_FOREIGN));
    assert.equal(doc.name, 'foreign request');
    const list = await fx.svc.listRequests({ collectionId: String(COLLECTION_FOREIGN) });
    assert.equal(list.length, 1);
  });

  await check('Admin-Rolle umgeht den Daten-Scope NICHT', async () => {
    const fx = buildFixture();
    // permissions.ts dokumentiert das ausdrücklich: der Rollen-Bypass gilt nur
    // für actorHasPermission, nicht für den Daten-Scope. Ein Admin mit bewusst
    // verengtem API-Key will genau diese Verengung.
    await RequestContext.run({
      userId: 'u-admin', username: 'admin', role: UserRole.ADMIN,
      projectScopeMode: 'allowlist', allowedProjectIds: [String(OWN_PROJECT)],
      customerScopeMode: 'allowlist', allowedCustomerIds: [],
    }, undefined, async () => {
      const err = await fx.svc.getRequest(String(REQUEST_FOREIGN)).then(() => null, (e) => e);
      assert.ok(err, 'ein verengter Admin hätte den fremden Request nicht lesen dürfen');
      assert.equal(err.getStatus(), 403);
    });
    // Ohne Verengung (Default 'all') bleibt der Admin uneingeschränkt.
    await RequestContext.run({ userId: 'a2', username: 'admin2', role: UserRole.ADMIN }, undefined, async () => {
      const doc = await fx.svc.getRequest(String(REQUEST_FOREIGN));
      assert.equal(doc.name, 'foreign request');
    });
  });

  console.log('');
  if (total !== EXPECTED_CHECKS) {
    console.error(
      `FEHLER: erwartet ${EXPECTED_CHECKS} Fälle, tatsächlich ${total} gelaufen — der Lauf wurde offenbar vorzeitig abgebrochen.`,
    );
    process.exit(1);
  }
  console.log(`Http requests scope checks: ${total - failures}/${total} passed`);
  process.exit(failures > 0 ? 1 : 0);
})();
