#!/usr/bin/env node
/*
 * Workspace- und Research-Scope-Check (Review-Funde C-10 und C-13, 2026-10-12).
 *
 * C-10: WorkspacesService.findById() war ein nackter Lookup. Über
 * POST /api/workspaces/:id/exec/stream (und alle workspace_*-MCP-Tools) lief
 * damit eine beliebige Shell im Container eines fremden Projekts, inklusive
 * der dort injizierten Git-Tokens.
 *
 * C-13: Im Research-Agent prüfte nur create() den Owner. get/update/remove
 * (mit Kaskade über Artefakte, Versionen und Runs), die Run-Steps und die
 * Artefakte waren für jeden authentifizierten Nutzer offen.
 *
 * Belegt: Ablehnung VOR jeder Mutation (Zähler), Positivfall, und dass der
 * interne Aufrufer ohne Actor (TTL-Sweep, Research-Scheduler) ungegated bleibt.
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
const { WorkspacesService } = loadCompiled('workspaces/workspaces.service.js');
const { ResearchTopicService } = loadCompiled('research-agent/research-topic.service.js');
const { ResearchRunService } = loadCompiled('research-agent/research-run.service.js');
const { ResearchArtifactService } = loadCompiled('research-agent/research-artifact.service.js');
const mongoose = loadCompiled('../node_modules/mongoose/index.js');
const { Types } = mongoose;

const EXPECTED_CHECKS = 10;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const OWN_PROJECT = new Types.ObjectId();
const FOREIGN_PROJECT = new Types.ObjectId();
const ME = new Types.ObjectId();
const OTHER = new Types.ObjectId();

function asActor(fn) {
  return RequestContext.run({
    userId: String(ME), username: 'me', role: 'user',
    projectScopeMode: 'allowlist', allowedProjectIds: [String(OWN_PROJECT)],
  }, undefined, fn);
}

async function expectStatus(status, fn) {
  await assert.rejects(fn, (err) => {
    assert.equal(err.status ?? err.getStatus?.(), status, `erwartet ${status}, war ${err.message}`);
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
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Types.ObjectId) && v.$in) {
      return v.$in.map(String).includes(String(doc[k]));
    }
    return String(doc[k]) === String(v);
  });
}

function makeModel(docs, counter) {
  return {
    findById: (id) => chain(docs.find((d) => String(d._id) === String(id)) ?? null),
    findOne: (f) => chain(docs.find((d) => matches(d, f)) ?? null),
    find: (f) => chain(docs.filter((d) => matches(d, f || {}))),
    findByIdAndUpdate: (id) => ({
      exec: async () => { counter.writes += 1; return docs.find((d) => String(d._id) === String(id)) ?? null; },
    }),
    findByIdAndDelete: (id) => ({
      exec: async () => { counter.deletes += 1; return docs.find((d) => String(d._id) === String(id)) ?? null; },
    }),
    deleteMany: () => ({ exec: async () => { counter.deletes += 1; return {}; } }),
    deleteOne: () => ({ exec: async () => { counter.deletes += 1; return {}; } }),
    create: async (d) => { counter.writes += 1; return { _id: new Types.ObjectId(), ...d }; },
  };
}

// ---- Workspaces -------------------------------------------------------------

function makeWorkspaces() {
  const counter = { writes: 0, deletes: 0 };
  const own = { _id: new Types.ObjectId(), projectId: OWN_PROJECT, name: 'own' };
  const foreign = { _id: new Types.ObjectId(), projectId: FOREIGN_PROJECT, name: 'foreign' };
  const svc = new WorkspacesService(makeModel([own, foreign], counter), { emit() {} });
  return { svc, counter, own, foreign };
}

// ---- Research ---------------------------------------------------------------

function makeResearch() {
  const counter = { writes: 0, deletes: 0 };
  const mine = {
    _id: new Types.ObjectId(), ownerUserId: ME, title: 'mine', number: 2,
    async save() { counter.writes += 1; },
  };
  const theirs = {
    _id: new Types.ObjectId(), ownerUserId: OTHER, title: 'theirs', number: 1,
    async save() { counter.writes += 1; },
  };
  const topicModel = makeModel([mine, theirs], counter);
  const theirRun = { _id: new Types.ObjectId(), topicId: theirs._id };
  const myRun = { _id: new Types.ObjectId(), topicId: mine._id };
  const runModel = makeModel([theirRun, myRun], counter);
  const theirArtifact = { _id: new Types.ObjectId(), topicId: theirs._id, slug: 'notes', title: 'n' };
  const artifactModel = makeModel([theirArtifact], counter);
  const versionModel = makeModel([], counter);
  const topics = new ResearchTopicService(topicModel, artifactModel, versionModel, runModel, {});
  const runs = new ResearchRunService(runModel, topicModel);
  const artifacts = new ResearchArtifactService(artifactModel, versionModel, { emit() {} }, topicModel);
  return { topics, runs, artifacts, counter, mine, theirs, theirRun, myRun, theirArtifact };
}

(async () => {
  await check('C-10 workspace findById/findByName: fremdes Projekt 403, eigenes ok', async () => {
    const f = makeWorkspaces();
    await asActor(async () => {
      await expectStatus(403, () => f.svc.findById(String(f.foreign._id)));
      await expectStatus(403, () => f.svc.findByName(String(FOREIGN_PROJECT), 'foreign'));
      assert.equal((await f.svc.findById(String(f.own._id))).name, 'own');
    });
  });

  await check('C-10 workspace update/archive/remove fremd: 403 und KEINE Mutation', async () => {
    const f = makeWorkspaces();
    await asActor(async () => {
      await expectStatus(403, () => f.svc.update(String(f.foreign._id), { name: 'x' }));
      await expectStatus(403, () => f.svc.archive(String(f.foreign._id)));
      await expectStatus(403, () => f.svc.remove(String(f.foreign._id)));
    });
    assert.deepEqual(f.counter, { writes: 0, deletes: 0 });
  });

  await check('C-10 workspace create/findByProject in fremdes Projekt: 403', async () => {
    const f = makeWorkspaces();
    await asActor(async () => {
      await expectStatus(403, () => f.svc.create({ projectId: String(FOREIGN_PROJECT), name: 'x' }));
      await expectStatus(403, () => f.svc.findByProject(String(FOREIGN_PROJECT)));
      assert.equal((await f.svc.findByProject(String(OWN_PROJECT))).length, 1);
    });
    assert.equal(f.counter.writes, 0);
  });

  await check('C-10 workspace: ohne Actor (TTL-Sweep) ungegated', async () => {
    const f = makeWorkspaces();
    assert.equal((await f.svc.findById(String(f.foreign._id))).name, 'foreign');
    await f.svc.archive(String(f.foreign._id));
    assert.equal(f.counter.writes, 1);
  });

  await check('C-13 topic get/update/remove fremd: 404 und KEINE Mutation/Kaskade', async () => {
    const f = makeResearch();
    await asActor(async () => {
      await expectStatus(404, () => f.topics.get(String(f.theirs._id)));
      await expectStatus(404, () => f.topics.update(String(f.theirs._id), { title: 'hijack' }));
      await expectStatus(404, () => f.topics.remove(String(f.theirs._id)));
      assert.equal((await f.topics.get(String(f.mine._id))).title, 'mine');
    });
    assert.deepEqual(f.counter, { writes: 0, deletes: 0 });
    assert.equal(f.theirs.title, 'theirs');
  });

  await check('C-13 topic list: nur eigene Themen; ohne Actor alle', async () => {
    const f = makeResearch();
    const mine = await asActor(() => f.topics.list());
    assert.deepEqual(mine.map((t) => t.title), ['mine']);
    const all = await f.topics.list();
    assert.equal(all.length, 2);
  });

  await check('C-13 run getRun/listByTopic fremd: 404; eigener Run ok', async () => {
    const f = makeResearch();
    await asActor(async () => {
      await expectStatus(404, () => f.runs.getRun(String(f.theirRun._id)));
      await expectStatus(404, () => f.runs.listByTopic(String(f.theirs._id)));
      assert.equal(String((await f.runs.getRun(String(f.myRun._id)))._id), String(f.myRun._id));
    });
  });

  await check('C-13 artifact list/get/write/remove/versions fremd: 404 und KEINE Mutation', async () => {
    const f = makeResearch();
    await asActor(async () => {
      await expectStatus(404, () => f.artifacts.listByTopic(String(f.theirs._id)));
      await expectStatus(404, () => f.artifacts.getBySlug(String(f.theirs._id), 'notes'));
      await expectStatus(404, () => f.artifacts.write(
        String(f.theirs._id), { slug: 'notes', title: 'x', content: 'x' }, { projectIds: [], customerIds: [] }));
      await expectStatus(404, () => f.artifacts.remove(String(f.theirs._id), 'notes'));
      await expectStatus(404, () => f.artifacts.listVersions(String(f.theirArtifact._id)));
    });
    assert.deepEqual(f.counter, { writes: 0, deletes: 0 });
  });

  await check('C-13 ungültige topicId: 404 statt CastError/500', async () => {
    const f = makeResearch();
    await asActor(async () => {
      await expectStatus(404, () => f.runs.listByTopic('nicht-hex'));
    });
  });

  await check('C-13 ohne Actor (Scheduler): fremde Runs/Artefakte erreichbar', async () => {
    const f = makeResearch();
    assert.equal((await f.runs.listByTopic(String(f.theirs._id))).length, 1);
    assert.equal((await f.artifacts.listByTopic(String(f.theirs._id))).length, 1);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
