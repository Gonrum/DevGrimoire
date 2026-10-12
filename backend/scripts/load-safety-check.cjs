#!/usr/bin/env node
/*
 * Verfügbarkeit unter Last (Review §8 Punkt 23: H-35, H-36, M-45, M-46, M-47).
 *
 * H-35  res.text() las den ganzen Body vor der Grössenprüfung -> OOM.
 *       Hier gegen einen echten lokalen HTTP-Server, der ENDLOS streamt.
 * H-36  Backup: Voll-Dump im Speicher + gzipSync. Geprüft wird, dass der
 *       Stream exakt das bisherige Format liefert (JSON.parse-gleich).
 * M-45  Monitoring sequentiell: ein hängender Check blockierte alle.
 * M-46  MINIO_MAX_FILE_SIZE galt nur für Multer, nicht für MCP/Base64.
 * M-47  stream.pipe(res) ohne Fehlerbehandlung -> hängende Responses.
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const http = require('node:http');
const { Readable, PassThrough } = require('node:stream');
const { ReadableStream } = require('node:stream/web');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

process.env.MINIO_MAX_FILE_SIZE = '1000';
const { readBodyCapped } = loadCompiled('common/read-body-capped.js');
const { BackupsService } = loadCompiled('backups/backups.service.js');
const { MonitoringService } = loadCompiled('monitoring/monitoring.service.js');
const { AttachmentsService } = loadCompiled('attachments/attachments.service.js');
const { base64DecodedSize } = loadCompiled('attachments/attachment-limits.js');

const EXPECTED_CHECKS = 7;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

(async () => {
  await check('H-35: endlos streamender Server -> nach der Grenze abgebrochen, Server sieht den Abbruch', async () => {
    let serverClosed = false;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const chunk = Buffer.alloc(64 * 1024, 'x');
      const timer = setInterval(() => res.write(chunk), 1);
      res.on('close', () => { serverClosed = true; clearInterval(timer); });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const out = await readBodyCapped(res, 100_000);
      assert.equal(out.truncated, true);
      assert.equal(out.bytesRead, 100_000);
      assert.equal(out.text.length, 100_000);
      for (let i = 0; i < 50 && !serverClosed; i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(serverClosed, 'Verbindung wurde nach dem Abbruch nicht freigegeben');
    } finally {
      server.close();
    }
  });

  await check('H-35: kleiner Body vollständig, UTF-8 über Chunk-Grenzen korrekt', async () => {
    const text = 'äöü€'.repeat(1000);
    const bytes = Buffer.from(text);
    const body = new ReadableStream({
      start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.subarray(i, i + 7)); c.close(); },
    });
    const out = await readBodyCapped(new globalThis.Response(body), 1_000_000);
    assert.equal(out.truncated, false);
    assert.equal(out.text, text);
    assert.equal(out.bytesRead, bytes.length);
  });

  await check('H-36: Backup-Stream ist gültiges Extended JSON und typtreu (ObjectId, Date)', async () => {
    const { mongo } = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));
    const id = new mongo.ObjectId();
    const date = new Date('2026-10-12T10:00:00Z');
    const data = {
      todos: [{ _id: id, title: 'x "quoted"', at: date, projectId: new mongo.ObjectId() }, { _id: 'b', n: 1 }],
      empty: [],
      refreshtokens: [{ token: 'h' }],
      'system.views': [{}],
    };
    const connection = {
      db: {
        listCollections: () => ({ toArray: async () => Object.keys(data).map((name) => ({ name })) }),
        collection: (name) => ({ find: () => data[name] }),
      },
    };
    const svc = new BackupsService({}, connection, {}, {});
    let json = '';
    for await (const chunk of svc.exportDatabaseStream()) json += chunk;
    const raw = JSON.parse(json);
    assert.equal(raw.format, 'devgrimoire.system-backup.database.v2');
    assert.deepEqual(Object.keys(raw.collections), ['todos', 'empty']);
    // Typen überleben den Roundtrip — mit JSON.stringify (v1) waren es Strings.
    const parsed = mongo.BSON.EJSON.parse(JSON.stringify(raw.collections.todos[0]), { relaxed: true });
    assert.ok(parsed._id instanceof mongo.ObjectId, '_id ist keine ObjectId mehr');
    assert.equal(parsed._id.toHexString(), id.toHexString());
    assert.ok(parsed.at instanceof Date, 'Datum ist kein Date mehr');
    assert.equal(parsed.at.getTime(), date.getTime());
    assert.equal(parsed.title, 'x "quoted"');
  });

  await check('M-45: ein hängender Check blockiert die anderen nicht', async () => {
    const svc = Object.create(MonitoringService.prototype);
    svc.inflight = new Set();
    svc.logger = { error() {} };
    const due = Array.from({ length: 6 }, (_, i) => ({ _id: { toString: () => `c${i}` } }));
    svc.checkModel = { find: () => ({ exec: async () => due }) };
    const finished = [];
    let release;
    const hang = new Promise((r) => { release = r; });
    svc.executeCheck = async (c) => {
      if (c._id.toString() === 'c0') await hang;
      finished.push(c._id.toString());
    };
    const run = svc.processDueChecks(new Date());
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(finished.sort(), ['c1', 'c2', 'c3', 'c4', 'c5'], 'die übrigen Checks warteten auf den hängenden');
    release();
    assert.equal(await run, 6);
  });

  await check('M-46: Base64-Upload über MINIO_MAX_FILE_SIZE -> 413 VOR dem Decodieren', async () => {
    const svc = Object.create(AttachmentsService.prototype);
    const big = Buffer.alloc(1001).toString('base64');
    assert.equal(base64DecodedSize(big), 1001);
    await assert.rejects(
      () => svc.createFromBase64({ projectId: 'p', fileName: 'a.txt' }, big),
      (e) => e.getStatus() === 413,
    );
  });

  await check('M-46: create() mit zu grossem Buffer -> 413 (auch ohne Multer)', async () => {
    const svc = Object.create(AttachmentsService.prototype);
    await assert.rejects(
      () => svc.create({ projectId: 'p' }, { buffer: Buffer.alloc(1001), originalname: 'a', mimetype: 'x' }),
      (e) => e.getStatus() === 413,
    );
    assert.equal(base64DecodedSize(Buffer.alloc(1000).toString('base64')), 1000);
  });

  await check('M-47: Fehler im Objekt-Stream beendet die Response statt sie hängen zu lassen', async () => {
    const { AttachmentsController } = loadCompiled('attachments/attachments.controller.js');
    const source = new Readable({ read() {} });
    const res = new PassThrough();
    res.setHeader = () => {};
    res.headersSent = true;
    let destroyed = false;
    const origDestroy = res.destroy.bind(res);
    res.destroy = (e) => { destroyed = true; return origDestroy(e); };
    res.on('error', () => {});
    const ctrl = new AttachmentsController({
      download: async () => ({ stream: source, attachment: { originalName: 'a', mimeType: 'x', size: 10 } }),
    }, {});
    await ctrl.download('id', res);
    source.push('abc');
    source.destroy(new Error('minio reset'));
    for (let i = 0; i < 20 && !destroyed; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(destroyed || res.destroyed, 'Response blieb nach Quellfehler offen');
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
