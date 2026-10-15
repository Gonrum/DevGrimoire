#!/usr/bin/env node
/*
 * Legacy-ResearchService (Webrecherche Plan 1, Abschluss-Review):
 * Listen/Suche ohne Dateitext und Laufinterna, MCP-Detail ohne Dateitext,
 * PUT während eines Laufs → 409, Kaskaden-Löschung stoppt aktive Läufe.
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
require(path.resolve(__dirname, '..', 'node_modules', 'reflect-metadata'));

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { ResearchService, researchDetailForTool } = loadCompiled('research/research.service.js');
const { RequestContext } = loadCompiled('common/request-context.js');
const { Types } = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const EXPECTED_CHECKS = 4;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const P = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const C = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const OWNER = '111111111111111111111111';
const admin = { userId: OWNER, username: 'a', role: 'admin' };

function chain(value, log) {
  const q = { sort: () => q, select: (s) => { log.select = s; return q; }, lean: () => q, exec: async () => value };
  return q;
}

function makeService(rows = []) {
  const log = { finds: [], updates: [], deletes: [], aborted: [], stepsRemoved: [] };
  const model = {
    find: (filter, projection) => { log.finds.push({ filter, projection }); return chain(rows, log); },
    findById: (id) => chain(rows.find((r) => String(r._id) === String(id)) ?? null, log),
    findOneAndUpdate: (filter, update) => { log.updates.push({ filter, update }); return chain({ ...rows[0], ...update, projectId: null, customerId: null }, log); },
    updateMany: (filter, update) => { log.updates.push({ filter, update }); return chain({ modifiedCount: 1 }, log); },
    deleteMany: (filter) => { log.deletes.push(filter); return chain({ deletedCount: rows.length }, log); },
  };
  const live = { abort: (id) => log.aborted.push(id) };
  const steps = { removeFor: async (id) => { log.stepsRemoved.push(id); } };
  const svc = new ResearchService(model, { emit() {} }, live, steps);
  return { svc, log };
}

(async () => {
  await check('findByProject/findByCustomer/search/listMine: Projektion ohne files.text, tasks, sourceList', async () => {
    const { svc, log } = makeService();
    await RequestContext.run(admin, undefined, async () => {
      await svc.findByProject(P);
      await svc.findByCustomer(C);
      await svc.search('wort', P);
      await svc.listMine();
    });
    assert.equal(log.finds.length, 4);
    for (const { projection } of log.finds) {
      assert.ok(projection, 'Projektion fehlt');
      assert.equal(projection['files.text'], 0);
      assert.equal(projection.tasks, 0);
      assert.equal(projection.sourceList, 0);
    }
    assert.deepEqual(log.finds[2].projection.score, { $meta: 'textScore' }, 'Textscore bleibt');
  });

  await check('researchDetailForTool (MCP research_get): Dateien nur mit Nummer und Name, Rest vollständig', () => {
    const doc = { toJSON: () => ({ title: 'T', content: 'Bericht', files: [{ n: 1, name: 'a.pdf', text: 'GEHEIMER TEXT', notes: 'x' }], tasks: [{ n: 1 }], sourceList: [{ n: 1 }] }) };
    const out = researchDetailForTool(doc);
    assert.deepEqual(out.files, [{ n: 1, name: 'a.pdf' }]);
    assert.ok(!JSON.stringify(out).includes('GEHEIMER TEXT'));
    assert.deepEqual(out.tasks, [{ n: 1 }]);
    assert.equal(out.content, 'Bericht');
  });

  await check('PUT /research/:id während queued/running → 409; sonst statusgeschütztes Update', async () => {
    const rid = new Types.ObjectId();
    for (const status of ['queued', 'running']) {
      const { svc, log } = makeService([{ _id: rid, status, ownerUserId: null, projectId: null, customerId: null }]);
      await assert.rejects(svc.update(String(rid), { title: 'x' }), (e) => e.getStatus() === 409);
      assert.equal(log.updates.length, 0, 'nichts geschrieben');
    }
    const { svc, log } = makeService([{ _id: rid, status: 'done', ownerUserId: null, projectId: null, customerId: null, title: 'T' }]);
    await svc.update(String(rid), { title: 'neu' });
    assert.equal(log.updates.length, 1);
    assert.deepEqual(log.updates[0].filter.status, { $nin: ['queued', 'running'] });
  });

  await check('removeByProject/removeByCustomer: aktive Läufe gestoppt (Flag + abort), Schritte entfernt, dann gelöscht', async () => {
    const run = new Types.ObjectId();
    const wait = new Types.ObjectId();
    const done = new Types.ObjectId();
    for (const via of ['removeByProject', 'removeByCustomer']) {
      const { svc, log } = makeService([{ _id: run, status: 'running' }, { _id: wait, status: 'queued' }, { _id: done, status: 'done' }]);
      await svc[via](via === 'removeByProject' ? P : C);
      const key = via === 'removeByProject' ? 'projectId' : 'customerId';
      assert.ok(log.finds[0].filter[key] instanceof Types.ObjectId, 'geprüfte ObjectId im Filter');
      assert.deepEqual(log.updates[0].update, { $set: { cancelRequested: true } });
      assert.deepEqual(log.updates[0].filter._id.$in.map(String), [String(run), String(wait)]);
      assert.deepEqual(log.aborted, [String(run), String(wait)]);
      assert.deepEqual(log.stepsRemoved.sort(), [String(run), String(wait), String(done)].sort());
      assert.equal(log.deletes.length, 1);
      assert.equal(String(log.deletes[0][key]), via === 'removeByProject' ? P : C);
    }
    const { svc } = makeService();
    await assert.rejects(svc.removeByProject({ $ne: null }), /Kaskaden-Löschung verweigert/);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) { console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`); process.exit(1); }
  process.exit(failures === 0 ? 0 : 1);
})();
