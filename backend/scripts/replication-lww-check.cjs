#!/usr/bin/env node
/*
 * Replication-LWW-Check (Review-Funde H-33 und H-34, 2026-10-12).
 *
 * H-33: Im Legacy-Empfangspfad (Default-Engine) lief ein Delete UNBEDINGT —
 * vor jeder Timestamp-Prüfung. Ein verspätetes oder erneut zugestelltes
 * Delete löschte auch eine lokal neuere Fassung.
 *
 * H-34: compareLww war strikt `>`, Gleichstand hiess „apply". Im Peer-Mode
 * wenden beide Seiten an: bei gleichem updatedAt tauschen A und B ihre
 * Inhalte und bleiben danach dauerhaft divergent.
 *
 * Belegt mit zwei echten ReplicationReceiveService-Instanzen gegen
 * In-Memory-Collections: Delete hinter LWW (beide Richtungen), Konvergenz bei
 * Gleichstand in BEIDEN Zustellreihenfolgen, Full-Sync mit demselben
 * Tie-Break, und dass alte Sender ohne Instanz-Id beim bisherigen Verhalten
 * bleiben.
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

const { ReplicationReceiveService } = loadCompiled('replication/replication-receive.service.js');
const { compareLww } = loadCompiled('replication/replication-log.helpers.js');
const { REPL_INSTANCE_ID } = loadCompiled('replication/replication.constants.js');
const { ObjectId } = require(path.resolve(__dirname, '..', 'node_modules', 'mongodb'));

const EXPECTED_CHECKS = 8;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const PROJECT = new ObjectId();
const ID_A = 'aaaaaaaa-0000-4000-8000-000000000000';
const ID_B = 'bbbbbbbb-0000-4000-8000-000000000000';

/** Eine Instanz: In-Memory-Collections + echter ReplicationReceiveService. */
function makeInstance(instanceId) {
  const collections = new Map();
  const coll = (name) => {
    if (!collections.has(name)) {
      const docs = new Map();
      collections.set(name, {
        _docs: docs,
        findOne: async (f) => docs.get(String(f._id)) ?? null,
        deleteOne: async (f) => { docs.delete(String(f._id)); return { deletedCount: 1 }; },
        replaceOne: async (f, doc) => { docs.set(String(f._id), { _id: f._id, ...doc }); return {}; },
      });
    }
    return collections.get(name);
  };
  const settings = { get: async (k) => (k === REPL_INSTANCE_ID ? instanceId : null) };
  const projects = { isReplicationEnabled: async () => true };
  const minio = { isEnabled: () => false };
  const svc = new ReplicationReceiveService({ db: { collection: coll } }, settings, minio, projects);
  return { svc, todos: coll('todos'), instanceId };
}

const todoPayload = (from, id, title, updatedAt) => ({
  event: { projectId: String(PROJECT), entity: 'todo', action: 'updated', entityId: String(id) },
  document: { _id: String(id), projectId: String(PROJECT), title, updatedAt: updatedAt.toISOString() },
  timestamp: updatedAt.toISOString(),
  sourceInstanceId: from,
});

const deletePayload = (from, id, at) => ({
  event: { projectId: String(PROJECT), entity: 'todo', action: 'deleted', entityId: String(id) },
  document: null,
  timestamp: at.toISOString(),
  sourceInstanceId: from,
});

(async () => {
  await check('compareLww: Tie-Break per Instanz-Id ist auf beiden Seiten komplementär', () => {
    // A empfängt von B, B empfängt von A — genau einer wendet an.
    const atA = compareLww(1000, 1000, { localInstanceId: ID_A, incomingInstanceId: ID_B });
    const atB = compareLww(1000, 1000, { localInstanceId: ID_B, incomingInstanceId: ID_A });
    assert.deepEqual([atA, atB].sort(), ['apply', 'skip']);
    assert.equal(atA, 'apply', 'die höhere Id (B) gewinnt');
    // Ohne Ids und bei gleicher Id: altes Verhalten.
    assert.equal(compareLww(1000, 1000), 'apply');
    assert.equal(compareLww(1000, 1000, { localInstanceId: ID_A, incomingInstanceId: null }), 'apply');
    assert.equal(compareLww(1000, 1000, { localInstanceId: ID_A, incomingInstanceId: ID_A }), 'apply');
    // Ungleiche Zeitstempel ignorieren den Tie-Break.
    assert.equal(compareLww(2000, 1000, { localInstanceId: ID_A, incomingInstanceId: ID_B }), 'skip');
    assert.equal(compareLww(1000, 2000, { localInstanceId: ID_B, incomingInstanceId: ID_A }), 'apply');
  });

  await check('H-33: verspätetes Delete trifft eine lokal NEUERE Fassung -> übersprungen', async () => {
    const a = makeInstance(ID_A);
    const id = new ObjectId();
    a.todos._docs.set(String(id), { _id: id, title: 'neu angelegt', updatedAt: new Date('2026-10-12T12:00:00Z') });
    const res = await a.svc.applyChange(deletePayload(ID_B, id, new Date('2026-10-12T11:00:00Z')));
    assert.equal(res.applied, false);
    assert.match(res.reason, /LWW/);
    assert.ok(a.todos._docs.has(String(id)), 'Dokument wurde trotz neuerer lokaler Fassung gelöscht');
  });

  await check('H-33: Delete nach der letzten lokalen Änderung -> angewendet', async () => {
    const a = makeInstance(ID_A);
    const id = new ObjectId();
    a.todos._docs.set(String(id), { _id: id, title: 'alt', updatedAt: new Date('2026-10-12T10:00:00Z') });
    const res = await a.svc.applyChange(deletePayload(ID_B, id, new Date('2026-10-12T11:00:00Z')));
    assert.equal(res.applied, true);
    assert.ok(!a.todos._docs.has(String(id)));
  });

  await check('H-33: Delete eines lokal nicht vorhandenen Dokuments bleibt ein No-op-Apply', async () => {
    const a = makeInstance(ID_A);
    const res = await a.svc.applyChange(deletePayload(ID_B, new ObjectId(), new Date()));
    assert.equal(res.applied, true);
  });

  await check('H-34: gleichzeitige Edits auf A und B konvergieren (Zustellung A->B zuerst)', async () => {
    const a = makeInstance(ID_A);
    const b = makeInstance(ID_B);
    const id = new ObjectId();
    const t = new Date('2026-10-12T12:00:00.123Z');
    a.todos._docs.set(String(id), { _id: id, title: 'von A', updatedAt: t });
    b.todos._docs.set(String(id), { _id: id, title: 'von B', updatedAt: t });
    await b.svc.applyChange(todoPayload(ID_A, id, 'von A', t));
    await a.svc.applyChange(todoPayload(ID_B, id, 'von B', t));
    assert.equal(a.todos._docs.get(String(id)).title, b.todos._docs.get(String(id)).title, 'Peers divergieren');
    assert.equal(a.todos._docs.get(String(id)).title, 'von B', 'die höhere Instanz-Id gewinnt');
  });

  await check('H-34: dieselbe Konvergenz bei umgekehrter Zustellreihenfolge', async () => {
    const a = makeInstance(ID_A);
    const b = makeInstance(ID_B);
    const id = new ObjectId();
    const t = new Date('2026-10-12T12:00:00.123Z');
    a.todos._docs.set(String(id), { _id: id, title: 'von A', updatedAt: t });
    b.todos._docs.set(String(id), { _id: id, title: 'von B', updatedAt: t });
    await a.svc.applyChange(todoPayload(ID_B, id, 'von B', t));
    await b.svc.applyChange(todoPayload(ID_A, id, 'von A', t));
    assert.equal(a.todos._docs.get(String(id)).title, 'von B');
    assert.equal(b.todos._docs.get(String(id)).title, 'von B');
  });

  await check('H-34: Full-Sync wendet denselben Tie-Break an (mit _sourceInstanceId)', async () => {
    const a = makeInstance(ID_A);
    const id = new ObjectId();
    const t = new Date('2026-10-12T12:00:00.123Z');
    a.todos._docs.set(String(id), { _id: id, title: 'von A', updatedAt: t });
    const doc = { _id: String(id), projectId: String(PROJECT), title: 'von B', updatedAt: t.toISOString() };
    // B -> A: B hat die höhere Id, A übernimmt.
    let res = await a.svc.applyFullSync({ todos: [doc], _sourceInstanceId: ID_B });
    assert.equal(res.entities, 1);
    assert.equal(a.todos._docs.get(String(id)).title, 'von B');
    // Gegenrichtung auf B: A hat die niedrigere Id, B behält.
    const b = makeInstance(ID_B);
    b.todos._docs.set(String(id), { _id: id, title: 'von B', updatedAt: t });
    res = await b.svc.applyFullSync({ todos: [{ ...doc, title: 'von A' }], _sourceInstanceId: ID_A });
    assert.equal(res.skipped, 1);
    assert.equal(b.todos._docs.get(String(id)).title, 'von B');
  });

  await check('Alter Sender ohne Instanz-Id: Gleichstand wird wie bisher angewendet', async () => {
    const b = makeInstance(ID_B);
    const id = new ObjectId();
    const t = new Date('2026-10-12T12:00:00.123Z');
    b.todos._docs.set(String(id), { _id: id, title: 'lokal', updatedAt: t });
    const res = await b.svc.applyFullSync({
      todos: [{ _id: String(id), projectId: String(PROJECT), title: 'remote', updatedAt: t.toISOString() }],
    });
    assert.equal(res.entities, 1);
    assert.equal(b.todos._docs.get(String(id)).title, 'remote');
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
