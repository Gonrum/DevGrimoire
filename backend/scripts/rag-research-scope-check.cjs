#!/usr/bin/env node
/*
 * RAG und persönliche Recherchen (Webrecherche Plan 1, Task 1, Fix-Runde).
 *
 * Nicht zugeordnete Recherchen (weder Projekt noch Kunde) dürfen nie im Index
 * landen — weder über den Change-Stream-Pfad (upsertDocument) noch über
 * rag_reindex (voll und projektbezogen). Sonst gälten ihre leeren Ids in der
 * Suche als globale Treffer und jeder Nutzer fände fremde Berichte.
 *
 * Echte LanceDB im Temp-Verzeichnis; Embedding und MongoDB sind Attrappen.
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
const { RagService, isUnassignedResearch } = loadCompiled('rag/rag.service.js');
const { ObjectId } = require(path.resolve(__dirname, '..', 'node_modules', 'mongodb'));

const EXPECTED_CHECKS = 3;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

async function makeRag(dir, docs) {
  process.env.RAG_DB_PATH = dir;
  const svc = Object.create(RagService.prototype);
  svc.logger = { log() {}, warn() {}, error() {}, debug() {} };
  const settings = new Map();
  svc.settings = {
    get: async (k) => settings.get(k) ?? null,
    set: async (k, v) => { settings.set(k, v); return { key: k, value: v }; },
  };
  svc.connection = {
    db: {
      collection: (name) => ({
        find: () => (name === 'researches' ? [...docs.values()] : []),
        findOne: async (f) => (name === 'researches' ? docs.get(String(f._id)) ?? null : null),
      }),
    },
  };
  Object.assign(svc, {
    db: null, table: null, dimensions: 0, embeddingModel: '', embeddingUrl: '', embeddingProvider: 'ollama',
    endpoints: [], ready: false, initPromise: null, writeChain: Promise.resolve(), indexMismatch: null, indexedWith: null,
  });
  svc.loadEndpoints = async () => [{ provider: 'ollama', url: 'http://x', model: 'm' }];
  svc.embedWithEndpoint = async () => new Array(4).fill(0.5);
  svc.getEmbedding = async (text) => new Array(4).fill(0).map((_, i) => ((text.length + i) % 7) / 7);
  await svc.reload();
  return svc;
}
const rows = async (svc, id) => (await svc.table.query().where(`sourceId = "${id}"`).toArray()).length;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-rag-research-'));
  try {
    const pid = new ObjectId();
    const personal = { _id: new ObjectId(), title: 'Geheim', content: 'persoenlicher bericht', ownerUserId: new ObjectId() };
    const assigned = { _id: new ObjectId(), title: 'Offen', content: 'projektbericht', projectId: pid };
    const docs = new Map([[String(personal._id), personal], [String(assigned._id), assigned]]);

    await check('Prädikat isUnassignedResearch', () => {
      assert.equal(isUnassignedResearch('research', personal), true);
      assert.equal(isUnassignedResearch('research', assigned), false);
      assert.equal(isUnassignedResearch('knowledge', personal), false);
    });

    await check('Voll-Reindex und projektbezogener Reindex überspringen persönliche Recherchen', async () => {
      const svc = await makeRag(path.join(root, 'a'), docs);
      await svc.reindex();
      assert.equal(await rows(svc, String(personal._id)), 0, 'persönlich nach Voll-Reindex');
      assert.equal(await rows(svc, String(assigned._id)), 1);
      await svc.reindex(String(pid));
      assert.equal(await rows(svc, String(personal._id)), 0, 'persönlich nach Projekt-Reindex');
      svc.onModuleDestroy();
    });

    await check('Change-Stream-Pfad: nicht indiziert, vorhandener Eintrag wird entfernt', async () => {
      const svc = await makeRag(path.join(root, 'b'), docs);
      await svc.handleProjectChange({ entity: 'research', action: 'created', entityId: String(personal._id) });
      assert.equal(await rows(svc, String(personal._id)), 0);
      await svc.handleProjectChange({ entity: 'research', action: 'created', entityId: String(assigned._id) });
      assert.equal(await rows(svc, String(assigned._id)), 1);
      // Recherche wird "abgelöst": Projekt weg -> Eintrag verschwindet
      docs.set(String(assigned._id), { ...assigned, projectId: undefined });
      await svc.handleProjectChange({ entity: 'research', action: 'updated', entityId: String(assigned._id) });
      assert.equal(await rows(svc, String(assigned._id)), 0);
      docs.set(String(assigned._id), assigned);
      svc.onModuleDestroy();
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) { console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`); process.exit(1); }
  process.exit(failures === 0 ? 0 : 1);
})();
