#!/usr/bin/env node
/**
 * T-466: der Empfänger des Full-Syncs (`applyFullSync`) gegen eine echte
 * MongoDB mit den echten Schemas.
 *
 * Der Full-Sync-Payload reist als JSON: jede ObjectId-Referenz kommt als
 * String an, jedes Datum als ISO-String. `applyFullSync` wandelte davon nur
 * `projectId` zurück — `todoId`, `topicId`, `customerId`,
 * `resolvedTargetUserIds` … landeten als String, und jede Abfrage per
 * ObjectId (also jede Mongoose-Abfrage) fand die Dokumente nicht mehr. Für die
 * acht in T-466 neu übertragenen Typen hiess „übertragen" damit nur „als
 * Leiche angekommen".
 *
 * Die Wandlung läuft über das Mongoose-Schema der Collection. ABER: alle mit
 * `@Prop({ type: Types.ObjectId })` deklarierten Felder sind wegen
 * @nestjs/mongoose in Wahrheit `Mixed` (Folge-Todo zu T-466) — dort castet
 * das Schema heute nichts. Dieser Check belegt deshalb die Mechanik an einem
 * korrekt typisierten Testschema und, dass die echten Schemas nicht schaden.
 *
 * Belegt:
 *   - mit korrekt typisiertem Schema: Referenzen werden zu ObjectIds, Daten zu
 *     Date (auch in Arrays und verschachtelt)
 *   - mit den heutigen (Mixed-)Schemas: nichts geht verloren, projectId wird
 *     weiterhin gecastet
 *   - unbekannte Felder (neuere Sender-Version) bleiben erhalten
 *   - unwandelbare Werte bleiben stehen statt den Datensatz zu verlieren
 *   - Collections ohne registriertes Modell laufen wie bisher durch
 *   - Anhänge: Binärdaten gehen nach MinIO, `_binaryBase64` landet NICHT im
 *     Mongo-Dokument
 *   - unbekannte Export-Keys im Payload werden übersprungen
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

const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));
require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/common')).Logger.overrideLogger(['error']);
const { Types } = mongoose;
const { ReplicationReceiveService } = require('../dist/replication/replication-receive.service');
const { EXPORT_COLLECTION } = require('../dist/replication/replication-collections');
const { Question, QuestionSchema } = require('../dist/questions/schemas/question.schema');
const { Harness, HarnessSchema } = require('../dist/harness/schemas/harness.schema');
const { Attachment, AttachmentSchema } = require('../dist/attachments/schemas/attachment.schema');

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

const keyOf = (collection) => {
  const hit = Object.entries(EXPORT_COLLECTION).find(([, c]) => c === collection);
  assert.ok(hit, `kein Export-Key für ${collection}`);
  return hit[0];
};
/** Wie über das Netz: ObjectId → String, Date → ISO-String. */
const overTheWire = (v) => JSON.parse(JSON.stringify(v));

(async () => {
  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    // Wie MongooseModule.forFeature: Modellname = Klassenname, Collection per Default.
    for (const [cls, schema] of [[Question, QuestionSchema], [Harness, HarnessSchema], [Attachment, AttachmentSchema]]) {
      conn.model(cls.name, schema);
    }
    // So sähe ein Schema nach dem Ursachen-Fix aus: Schema.Types.ObjectId statt
    // Types.ObjectId. Collection `researchartifacts`, damit der Full-Sync sie
    // als replizierte Collection behandelt.
    const OID = mongoose.Schema.Types.ObjectId;
    conn.model('TypedArtifact', new mongoose.Schema({
      topicId: OID, projectId: OID, lastRunId: OID, relatedIds: [OID],
      scope: { projectIds: [OID] }, title: String,
    }, { timestamps: true }), 'researchartifacts');
    const db = conn.db;
    const puts = [];
    const svc = new ReplicationReceiveService(
      conn,
      { get: async () => 'local-instance' },
      { isEnabled: () => true, putObject: async (key, buf, mime) => { puts.push({ key, buf, mime }); } },
      {},
    );

    const projectId = new Types.ObjectId();
    const todoId = new Types.ObjectId();
    const userA = new Types.ObjectId();
    const topicId = new Types.ObjectId();
    const now = new Date('2026-11-05T10:00:00.000Z');

    const question = {
      _id: new Types.ObjectId(), question: 'q?', options: [], direction: 'agent_to_user', status: 'pending',
      projectId, todoId, resolvedTargetUserIds: [userA], createdByUserId: userA,
      expiresAt: now, createdAt: now, updatedAt: now,
      zukunftsfeld: { von: 'neuerer Sender' },
    };
    const harness = {
      _id: new Types.ObjectId(), scope: 'project', projectId, sections: [], createdAt: now, updatedAt: now,
    };
    const artifact = {
      _id: new Types.ObjectId(), topicId, projectId, title: 'a', createdAt: now, updatedAt: now,
      relatedIds: [todoId], scope: { projectIds: [projectId] }, extra: 'bleibt',
    };
    const attachment = {
      _id: new Types.ObjectId(), projectId, entityType: 'todo', entityId: todoId, filename: 'a.txt',
      mimeType: 'text/plain', size: 5, storageKey: `attachments/${projectId}/a.txt`,
      _binaryBase64: Buffer.from('hallo').toString('base64'), createdAt: now, updatedAt: now,
    };
    const unknownModel = { _id: new Types.ObjectId(), projectId, todoId, updatedAt: now };

    const payload = overTheWire({
      [keyOf('questions')]: [question],
      [keyOf('harnesses')]: [harness],
      [keyOf('researchartifacts')]: [artifact],
      [keyOf('attachments')]: [attachment],
      // Collection ohne registriertes Modell in diesem Test (todos):
      [keyOf('todos')]: [unknownModel],
      gibtsNochNicht: [{ _id: new Types.ObjectId().toString() }],
    });
    // Unwandelbarer Wert in einem ObjectId-Feld:
    payload[keyOf('questions')][0].chatSessionId = 'kein-objectid';

    const result = await svc.applyFullSync(payload);

    await check('applyFullSync: alle fünf angewandt, keine Fehler', async () => {
      assert.deepEqual(result, { entities: 5, errors: 0, skipped: 0 });
    });

    await check('typisiertes Schema: Referenzen (auch Array/verschachtelt) als ObjectId, Daten als Date', async () => {
      const a = await db.collection('researchartifacts').findOne({ _id: artifact._id });
      assert.ok(a.topicId instanceof Types.ObjectId, `topicId ist ${typeof a.topicId}`);
      assert.ok(a.relatedIds.every((x) => x instanceof Types.ObjectId), 'Array-Elemente');
      assert.ok(a.scope.projectIds.every((x) => x instanceof Types.ObjectId), 'verschachtelt');
      assert.ok(a.createdAt instanceof Date);
      assert.equal(a.extra, 'bleibt', 'unbekanntes Feld verloren');
      const viaModel = await conn.model('TypedArtifact').findOne({ topicId }).exec();
      assert.ok(viaModel, 'per topicId (ObjectId) nicht auffindbar');
    });

    await check('heutiges Frage-Schema (Mixed): nichts verloren, projectId und Daten gewandelt', async () => {
      const q = await db.collection('questions').findOne({ _id: question._id });
      assert.ok(q.projectId instanceof Types.ObjectId);
      assert.ok(q.expiresAt instanceof Date && q.createdAt instanceof Date);
      assert.equal(String(q.todoId), String(todoId));
      if (!(q.todoId instanceof Types.ObjectId)) {
        console.log('     (bekannt: todoId bleibt String, solange das Schema Mixed ist — Folge-Todo)');
      }
    });

    await check('Frage: unbekanntes Feld bleibt, unwandelbarer Wert bleibt stehen', async () => {
      const q = await db.collection('questions').findOne({ _id: question._id });
      assert.deepEqual(q.zukunftsfeld, { von: 'neuerer Sender' });
      assert.equal(q.chatSessionId, 'kein-objectid');
    });

    await check('Harness: projectId als ObjectId', async () => {
      const h = await db.collection('harnesses').findOne({ _id: harness._id });
      assert.ok(h.projectId instanceof Types.ObjectId);
    });

    await check('Collection ohne Modell: läuft wie bisher (projectId gecastet, Rest unverändert)', async () => {
      const t = await db.collection('todos').findOne({ _id: unknownModel._id });
      assert.ok(t.projectId instanceof Types.ObjectId);
      assert.equal(typeof t.todoId, 'string');
      assert.ok(t.updatedAt instanceof Date);
    });

    await check('Anhang: Binärdaten nach MinIO, _binaryBase64 nicht im Mongo-Dokument', async () => {
      assert.equal(puts.length, 1);
      assert.equal(puts[0].buf.toString(), 'hallo');
      assert.equal(puts[0].key, attachment.storageKey);
      const doc = await db.collection('attachments').findOne({ _id: attachment._id });
      assert.equal(doc._binaryBase64, undefined, '_binaryBase64 wurde in Mongo gespeichert');
      assert.equal(doc.storageKey, attachment.storageKey);
    });

    await check('unbekannter Export-Key: übersprungen, nichts angelegt', async () => {
      const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
      assert.ok(!names.includes('gibtsNochNicht'));
    });

    await check('zweiter Lauf mit demselben Stand: LWW überspringt, keine Fehler', async () => {
      const again = await svc.applyFullSync(payload);
      assert.equal(again.errors, 0);
    });
  } finally {
    await conn.dropDatabase().catch(() => {});
    await conn.close();
  }
  console.log(`${passed} passed`);
})();
