#!/usr/bin/env node
/*
 * RAG-Index-Konsistenz (Review-Funde M-15, M-16, 2026-10-13).
 *
 * M-15: Voll-Reindex und inkrementeller Sync schrieben unkoordiniert in
 *       dieselbe Tabelle; `add` ist kein Upsert, also entstanden Duplikate.
 *       Ein Embedding-Fehler zwischen delete und add liess ein Dokument still
 *       aus dem Index verschwinden.
 * M-16: Nach einem Modellwechsel (andere Dimension) wurde die alte Tabelle
 *       ohne Vergleich geöffnet; jeder Sync scheiterte nur als warn.
 *
 * Gegen eine ECHTE LanceDB in einem Temp-Verzeichnis. Ersetzt sind nur das
 * Embedding (deterministische Vektoren) und MongoDB (In-Memory-Collections).
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { RagService } = loadCompiled('rag/rag.service.js');
const { ObjectId } = require(path.resolve(__dirname, '..', 'node_modules', 'mongodb'));

const EXPECTED_CHECKS = 5;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ein RagService mit echter LanceDB in `dir`, Embedding-Dimension `dims`. */
async function makeRag(dir, { dims, model = 'm1', settings = new Map(), docs = new Map(), embedDelayMs = 0 }) {
  process.env.RAG_DB_PATH = dir;
  const svc = Object.create(RagService.prototype);
  svc.logger = { log() {}, warn() {}, error() {}, debug() {} };
  svc.settings = {
    get: async (k) => settings.get(k) ?? null,
    set: async (k, v) => { settings.set(k, v); return { key: k, value: v }; },
  };
  svc.connection = {
    db: {
      // Nur die Knowledge-Collection hat Inhalt — sonst würde jedes Dokument
      // einmal pro Entity-Typ indiziert.
      collection: (name) => ({
        find: () => (name === 'knowledges' ? [...docs.values()] : []),
        findOne: async (f) => (name === 'knowledges' ? docs.get(String(f._id)) ?? null : null),
      }),
    },
  };
  // Klassenfelder setzt Object.create nicht — von Hand wie im Konstruktor.
  Object.assign(svc, {
    db: null, table: null, dimensions: 0, embeddingModel: '', embeddingUrl: '', embeddingProvider: 'ollama',
    endpoints: [], ready: false, initPromise: null, writeChain: Promise.resolve(), indexMismatch: null, indexedWith: null,
  });
  svc.loadEndpoints = async () => [{ provider: 'ollama', url: 'http://x', model }];
  svc.embedWithEndpoint = async () => new Array(dims).fill(0.5);
  svc.embedFail = false;
  svc.getEmbedding = async (text) => {
    if (embedDelayMs) await sleep(embedDelayMs);
    if (svc.embedFail) throw new Error('embedding down');
    return new Array(dims).fill(0).map((_, i) => ((text.length + i) % 7) / 7);
  };
  await svc.reload();
  return { svc, settings, docs };
}

async function rowsFor(svc, id) {
  return (await svc.table.query().where(`sourceId = "${id}"`).toArray()).length;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-rag-check-'));
  try {
    await check('M-16: andere Dimension -> Index gesperrt (Suche, Sync, Teil-Reindex), voller Reindex heilt', async () => {
      const dir = path.join(root, 'dims');
      const settings = new Map();
      const docs = new Map();
      const id = new ObjectId();
      docs.set(String(id), { _id: id, topic: 'T', content: 'hallo welt', projectId: new ObjectId() });
      const a = await makeRag(dir, { dims: 4, settings, docs });
      await a.svc.reindex();
      a.svc.onModuleDestroy();

      const b = await makeRag(dir, { dims: 8, model: 'm2', settings, docs });
      assert.match(b.svc.indexMismatch, /4 Dimensionen.*8/);
      await assert.rejects(() => b.svc.search('x'), /RAG-Index unbrauchbar/);
      await assert.rejects(() => b.svc.reindex(String(new ObjectId())), (e) => e.getStatus?.() === 400);
      const st = await b.svc.status();
      assert.match(st.index.reindexRequired, /voller rag_reindex/);
      await b.svc.handleProjectChange({ entity: 'knowledge', action: 'updated', entityId: String(id) }); // darf nicht werfen
      await b.svc.reindex();
      assert.equal(b.svc.indexMismatch, null);
      assert.equal(JSON.parse(settings.get('rag_index_meta')).dimensions, 8);
      assert.equal((await b.svc.search('hallo')).length, 1);
      b.svc.onModuleDestroy();
    });

    await check('M-16: gleiche Dimension, anderer Modellname -> nur Hinweis, keine Sperre', async () => {
      const dir = path.join(root, 'name');
      const settings = new Map();
      const a = await makeRag(dir, { dims: 4, model: 'text-embedding-nomic', settings });
      await a.svc.reindex();
      a.svc.onModuleDestroy();
      const b = await makeRag(dir, { dims: 4, model: 'nomic', settings });
      assert.equal(b.svc.indexMismatch, null);
      assert.equal((await b.svc.status()).index.indexedWith.model, 'text-embedding-nomic');
      b.svc.onModuleDestroy();
    });

    await check('M-16: Altbestand ohne Metadaten übernimmt das aktive Modell', async () => {
      const dir = path.join(root, 'legacy');
      const settings = new Map();
      const a = await makeRag(dir, { dims: 4, settings });
      settings.delete('rag_index_meta');
      a.svc.onModuleDestroy();
      const b = await makeRag(dir, { dims: 4, model: 'm1', settings });
      assert.equal(JSON.parse(settings.get('rag_index_meta')).model, 'm1');
      b.svc.onModuleDestroy();
    });

    await check('M-15: Upserts während eines Voll-Reindex hinterlassen keine Duplikate', async () => {
      const dir = path.join(root, 'race');
      const docs = new Map();
      const ids = [];
      for (let i = 0; i < 6; i++) {
        const id = new ObjectId();
        ids.push(String(id));
        docs.set(String(id), { _id: id, topic: `T${i}`, content: `inhalt ${i}`, projectId: new ObjectId() });
      }
      const { svc } = await makeRag(dir, { dims: 4, docs, embedDelayMs: 15 });
      const reindex = svc.reindex();
      await sleep(30);
      // Während der Reindex läuft: dasselbe Dokument mehrfach inkrementell.
      await Promise.all([0, 1, 2].map(() => svc.handleProjectChange({ entity: 'knowledge', action: 'updated', entityId: ids[0] })));
      await reindex;
      await svc.writeChain;
      for (const id of ids) assert.equal(await rowsFor(svc, id), 1, `Dokument ${id} hat Duplikate`);
      svc.onModuleDestroy();
    });

    await check('M-15: Embedding-Fehler beim Update lässt die alte Fassung im Index', async () => {
      const dir = path.join(root, 'fail');
      const docs = new Map();
      const id = new ObjectId();
      docs.set(String(id), { _id: id, topic: 'T', content: 'v1', projectId: new ObjectId() });
      const { svc } = await makeRag(dir, { dims: 4, docs });
      await svc.handleProjectChange({ entity: 'knowledge', action: 'created', entityId: String(id) });
      assert.equal(await rowsFor(svc, String(id)), 1);
      docs.get(String(id)).content = 'v2';
      svc.embedFail = true;
      await svc.handleProjectChange({ entity: 'knowledge', action: 'updated', entityId: String(id) });
      assert.equal(await rowsFor(svc, String(id)), 1, 'Dokument nach gescheitertem Embedding verschwunden');
      svc.onModuleDestroy();
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
