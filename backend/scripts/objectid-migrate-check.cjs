#!/usr/bin/env node
/**
 * T-510: ObjectId-Migration (`dist/common/objectid-migration.js`, Skript
 * `objectid-migrate.cjs`, Start-Lauf `objectid-migration.boot.js`) gegen eine
 * echte MongoDB.
 *
 * Belegt:
 *   - Pfad-Ermittlung aus den Schemas: skalar, Array, verschachtelt,
 *     Subdokument-Array; das echte TodoSchema liefert projectId/blockedBy
 *   - Trockenlauf zählt und schreibt nichts
 *   - --apply wandelt Strings in ObjectIds (auch in Arrays und Subdokumenten),
 *     '' wird null, andere Felder bleiben unberührt
 *   - unwandelbare Werte bleiben stehen und werden gemeldet
 *   - Unique-Konflikt: Dokument bleibt unverändert, wird gemeldet, Lauf bricht
 *     nicht ab
 *   - Idempotenz: ein zweiter Lauf findet nichts mehr
 *   - danach findet eine Mongoose-Abfrage mit String-Id die Dokumente
 *   - Start-Lauf: migriert über connection.models, setzt den Marker, der
 *     zweite Start rührt nichts mehr an
 *
 * Braucht MONGODB_TEST_URI (Wegwerf-Datenbank, wird danach gelöscht).
 * Nach `npm run build` ausführen.
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const uri = process.env.MONGODB_TEST_URI;
if (!uri) {
  console.log('(übersprungen: MONGODB_TEST_URI nicht gesetzt)');
  process.exit(0);
}

const mongoose = require('mongoose');
const { objectIdPaths, pathsByCollection, migrateObjectIds: run } = require('../dist/common/objectid-migration');
const { loadSchemas, registerModels } = require('./objectid-migrate.cjs');
const { runObjectIdMigrationOnce } = require('../dist/common/objectid-migration.boot');
require('@nestjs/common').Logger.overrideLogger(['error']);
const { Types, Schema } = mongoose;
const OID = Schema.Types.ObjectId;

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  }
}


(async () => {
  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const stepSchema = new Schema({ todoId: OID, label: String }, { _id: false });
    const schema = new Schema({
      projectId: { type: OID, index: { unique: true, sparse: true } },
      milestoneId: OID,
      blockedBy: [OID],
      scope: { projectIds: [OID] },
      steps: [stepSchema],
      slug: String,
    });
    const Thing = conn.model('Thing', schema, 'things');
    await Thing.syncIndexes();
    const byColl = new Map([['things', objectIdPaths(schema)]]);

    await check('objectIdPaths: skalar, Array, verschachtelt, Subdokument-Array', async () => {
      const got = objectIdPaths(schema).map((s) => s.join('.')).sort();
      assert.deepEqual(got, ['blockedBy.[]', 'milestoneId', 'projectId', 'scope.projectIds.[]', 'steps.[].todoId']);
    });

    await check('echte Schemas aus dist/: Todo liefert projectId und blockedBy', async () => {
      const real = loadSchemas(path.join(__dirname, '..', 'dist'));
      const todo = real.find((s) => s.modelName === 'Todo');
      assert.ok(todo);
      const got = objectIdPaths(todo.schema).map((s) => s.join('.'));
      assert.ok(got.includes('projectId') && got.includes('blockedBy.[]'), got.join(', '));
      const scratch = mongoose.createConnection();
      const map = pathsByCollection(registerModels(scratch, real));
      assert.ok(map.get('todos'), 'todos fehlt in der Collection-Zuordnung');
      assert.ok(map.size >= 50, `nur ${map.size} Collections`);
      await scratch.close();
    });

    const p1 = new Types.ObjectId();
    const p2 = new Types.ObjectId();
    const t1 = new Types.ObjectId();
    const coll = conn.db.collection('things');
    const ids = {
      strings: new Types.ObjectId(),
      already: new Types.ObjectId(),
      bad: new Types.ObjectId(),
      dupe: new Types.ObjectId(),
      dupeTarget: new Types.ObjectId(),
    };
    await coll.insertMany([
      {
        _id: ids.strings, projectId: p1.toString(), milestoneId: '', blockedBy: [t1.toString(), t1],
        scope: { projectIds: [p1.toString()] }, steps: [{ todoId: t1.toString(), label: 'x' }], slug: p1.toString(),
      },
      { _id: ids.already, projectId: p2, blockedBy: [t1] },
      { _id: ids.bad, milestoneId: 'GamePlaner' },
      // Unique-Konflikt: dieselbe Referenz einmal als ObjectId, einmal als String.
      { _id: ids.dupeTarget, projectId: new Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa') },
      { _id: ids.dupe, projectId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
    ]);

    await check('Trockenlauf: zählt, schreibt nichts', async () => {
      const report = await run(conn.db, byColl);
      const r = report.find((x) => x.collection === 'things');
      assert.equal(r.docs, 3);
      assert.equal(r.paths.projectId.castable, 2);
      assert.equal(r.paths.milestoneId.castable, 1, "'' zählt als wandelbar (→ null)");
      assert.equal(r.paths.milestoneId.uncastable, 1);
      assert.equal(r.paths['blockedBy[]'].castable, 1);
      assert.equal(r.paths['steps[].todoId'].castable, 1);
      assert.equal(r.written, 0);
      const doc = await coll.findOne({ _id: ids.strings });
      assert.equal(typeof doc.projectId, 'string');
    });

    let applied;
    await check('--apply: Strings → ObjectId, auch Array/verschachtelt/Subdokument; "" → null', async () => {
      applied = (await run(conn.db, byColl, { apply: true })).find((x) => x.collection === 'things');
      const doc = await coll.findOne({ _id: ids.strings });
      assert.ok(doc.projectId instanceof Types.ObjectId);
      assert.equal(doc.milestoneId, null);
      assert.ok(doc.blockedBy.every((x) => x instanceof Types.ObjectId));
      assert.ok(doc.scope.projectIds[0] instanceof Types.ObjectId);
      assert.ok(doc.steps[0].todoId instanceof Types.ObjectId);
      assert.equal(doc.steps[0].label, 'x');
      assert.equal(typeof doc.slug, 'string', 'Nicht-Referenzfeld angefasst');
    });

    await check('unwandelbar: bleibt stehen', async () => {
      const doc = await coll.findOne({ _id: ids.bad });
      assert.equal(doc.milestoneId, 'GamePlaner');
    });

    await check('Unique-Konflikt: Dokument unverändert, gemeldet, Lauf lief weiter', async () => {
      assert.deepEqual(applied.conflicts, [String(ids.dupe)]);
      const doc = await coll.findOne({ _id: ids.dupe });
      assert.equal(typeof doc.projectId, 'string');
      assert.equal(applied.written, 1, 'nur das wandelbare Dokument (bad hat keine Änderung)');
    });

    await check('idempotent: zweiter Lauf findet nur noch Unwandelbares und den Konflikt', async () => {
      const again = (await run(conn.db, byColl, { apply: true })).find((x) => x.collection === 'things');
      assert.equal(again.written, 0);
      assert.equal(again.paths.projectId.castable, 1, 'nur der Konflikt');
      assert.equal(again.paths.milestoneId.uncastable, 1);
      assert.equal(again.paths['blockedBy[]'], undefined);
    });

    await check('danach: Mongoose-Abfrage mit String-Id findet das Dokument', async () => {
      const hit = await Thing.findOne({ projectId: p1.toString() }).lean();
      assert.ok(hit && String(hit._id) === String(ids.strings));
      const blocked = await Thing.find({ blockedBy: t1.toString() }).lean();
      assert.equal(blocked.length, 2);
    });

    await check('Start-Lauf: migriert über connection.models, Marker verhindert zweiten Lauf', async () => {
      const id = new Types.ObjectId();
      await coll.insertOne({ _id: id, projectId: new Types.ObjectId().toString() });
      await runObjectIdMigrationOnce(conn);
      const doc = await coll.findOne({ _id: id });
      assert.ok(doc.projectId instanceof Types.ObjectId);
      const marker = await conn.db.collection('migrations').findOne({ _id: 't510-objectid-refs' });
      assert.ok(marker && marker.doneAt instanceof Date);
      const later = new Types.ObjectId();
      await coll.insertOne({ _id: later, milestoneId: new Types.ObjectId().toString() });
      await runObjectIdMigrationOnce(conn);
      assert.equal(typeof (await coll.findOne({ _id: later })).milestoneId, 'string', 'zweiter Start hat migriert');
    });
  } finally {
    await conn.dropDatabase().catch(() => {});
    await conn.close();
  }
  console.log(`${passed} passed`);
})();
