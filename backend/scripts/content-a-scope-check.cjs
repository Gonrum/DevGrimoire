#!/usr/bin/env node
/*
 * Content scope check (slice content-a): knowledge graph, snippets,
 * milestones, changelog, manuals, features.
 *
 * Before the fix none of these services checked the caller's scope: by-id
 * reads/writes/deletes hit foreign entities, `knowledge_graph_list` and
 * `snippet_search` without an owner returned every project, and creates
 * accepted foreign owner ids (the controller pipe only validated format).
 *
 * This check pins, for a narrowed actor (allowlist on both axes):
 *   - foreign by-id get/update/delete -> 403 and NOTHING was written
 *   - list/search without owner -> only in-scope entities
 *   - list/create with a foreign owner param -> 403
 *   - relation entities (own project + foreign customer) stay hidden
 *   - milestone: foreign changelog cannot be linked, a conflicting foreign
 *     milestone's name does not leak
 *   - internal callers (no actor) still see everything
 *
 * Loads from dist/; run `npm run build` first.
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
const { KnowledgeGraphService } = loadCompiled('knowledge-graph/knowledge-graph.service.js');
const { SnippetsService } = loadCompiled('snippets/snippets.service.js');
const { MilestonesService } = loadCompiled('milestones/milestones.service.js');
const { ChangelogService } = loadCompiled('changelog/changelog.service.js');
const { ManualsService } = loadCompiled('manuals/manuals.service.js');
const { FeaturesService } = loadCompiled('features/features.service.js');
const { Types } = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const EXPECTED_CHECKS = 12;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const statusOf = (e) => (e && typeof e.getStatus === 'function' ? e.getStatus() : undefined);
const is403 = (e) => statusOf(e) === 403;
const oid = () => new Types.ObjectId();

const OWN_PROJECT = oid();
const FOREIGN_PROJECT = oid();
const OWN_CUSTOMER = oid();
const FOREIGN_CUSTOMER = oid();

function asScoped(fn) {
  return RequestContext.run({
    userId: 'u-scoped', username: 'scoped', role: 'user',
    projectScopeMode: 'allowlist', allowedProjectIds: [OWN_PROJECT.toString()],
    customerScopeMode: 'allowlist', allowedCustomerIds: [OWN_CUSTOMER.toString()],
  }, undefined, fn);
}

// ---- in-memory model -------------------------------------------------------

function get(doc, key) {
  return key.split('.').reduce((v, k) => (v == null ? undefined : v[k]), doc);
}

/** Minimal Mongo matcher: $and/$or/$in/$ne/$exists, dotted paths; $text is ignored. */
function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$and') return v.every((f) => matches(doc, f));
    if (k === '$or') return v.some((f) => matches(doc, f));
    if (k === '$text') return true;
    const actual = get(doc, k);
    if (v && typeof v === 'object' && !(v instanceof Types.ObjectId) && !Array.isArray(v)) {
      if ('$in' in v) return v.$in.map(String).includes(String(actual));
      if ('$ne' in v) return String(actual) !== String(v.$ne);
      if ('$exists' in v) return (actual !== undefined) === v.$exists;
    }
    if (v === null) return actual === null || actual === undefined;
    return String(actual) === String(v);
  });
}

const counter = { writes: 0, deletes: 0 };
function reset() { counter.writes = 0; counter.deletes = 0; }

function makeModel(docs) {
  const store = new Map();
  const wrap = (d) => ({ ...d, async save() { counter.writes += 1; } });
  for (const d of docs) store.set(String(d._id), wrap(d));
  const chain = (value) => ({
    select: () => chain(value), sort: () => chain(value), limit: () => chain(value),
    lean: () => chain(value), exec: async () => value,
  });
  return {
    _store: store,
    findById: (id) => chain(store.get(String(id)) ?? null),
    findOne: (f) => chain([...store.values()].find((d) => matches(d, f)) ?? null),
    find: (f) => chain([...store.values()].filter((d) => matches(d, f || {}))),
    findByIdAndUpdate: (id, upd) => ({
      exec: async () => {
        const doc = store.get(String(id));
        if (!doc) return null;
        counter.writes += 1;
        Object.assign(doc, upd && upd.$set ? upd.$set : upd);
        return doc;
      },
    }),
    findByIdAndDelete: (id) => ({
      exec: async () => {
        const doc = store.get(String(id));
        if (!doc) return null;
        counter.deletes += 1;
        store.delete(String(id));
        return doc;
      },
    }),
    deleteOne: (f) => ({
      exec: async () => {
        for (const [key, d] of store) if (matches(d, f)) { store.delete(key); counter.deletes += 1; return { deletedCount: 1 }; }
        return { deletedCount: 0 };
      },
    }),
    updateOne: async () => { counter.writes += 1; return { upsertedCount: 0 }; },
    async create(doc) {
      counter.writes += 1;
      const s = wrap({ _id: oid(), ...doc });
      store.set(String(s._id), s);
      return s;
    },
    collection: {
      findOne: async (f) => [...store.values()].find((d) => matches(d, f)) ?? null,
    },
  };
}

const emitter = { emit: () => {} };

async function expect403NoMutation(fn) {
  reset();
  await assert.rejects(fn, is403);
  assert.equal(counter.writes, 0, 'no write after a rejected call');
  assert.equal(counter.deletes, 0, 'no delete after a rejected call');
}

(async () => {
  // ---- knowledge graph ------------------------------------------------------
  const edge = (projectId, label) => ({
    _id: oid(), projectId,
    source: { entityType: 'todo', entityId: 'a', label },
    target: { entityType: 'knowledge', entityId: 'b', label },
    relation: 'references', createdBy: 'user', userConfirmed: true,
  });
  const ownEdge = edge(OWN_PROJECT, 'own');
  const foreignEdge = edge(FOREIGN_PROJECT, 'FOREIGN LABEL');
  const edgeModel = makeModel([ownEdge, foreignEdge]);
  const empty = () => makeModel([]);
  const kg = new KnowledgeGraphService(edgeModel, empty(), empty(), empty(), empty(), empty(), empty(), empty(), empty(), emitter);

  await check('knowledge graph: list without projectId returns only in-scope edges; foreign projectId -> 403', async () => {
    const list = await asScoped(() => kg.list({}));
    assert.deepEqual(list.map((e) => String(e._id)), [String(ownEdge._id)]);
    await assert.rejects(() => asScoped(() => kg.list({ projectId: FOREIGN_PROJECT.toString() })), is403);
    const internal = await kg.list({});
    assert.equal(internal.length, 2, 'internal caller sees everything');
  });

  await check('knowledge graph: foreign edge get/confirm/remove -> 403 without mutation', async () => {
    const id = String(foreignEdge._id);
    await expect403NoMutation(() => asScoped(() => kg.findById(id)));
    await expect403NoMutation(() => asScoped(() => kg.confirm(id, false)));
    await expect403NoMutation(() => asScoped(() => kg.remove(id)));
    assert.ok(edgeModel._store.has(id));
    const own = await asScoped(() => kg.findById(String(ownEdge._id)));
    assert.equal(String(own._id), String(ownEdge._id));
  });

  await check('knowledge graph: neighbors/impact/discover/create on a foreign project -> 403', async () => {
    const p = FOREIGN_PROJECT.toString();
    await assert.rejects(() => asScoped(() => kg.neighbors(p, 'todo', 'a')), is403);
    await assert.rejects(() => asScoped(() => kg.impact(p, 'todo', 'a', 2)), is403);
    await expect403NoMutation(() => asScoped(() => kg.discoverForProject(p)));
    await expect403NoMutation(() => asScoped(() => kg.create({
      projectId: p, source: { entityType: 'todo', entityId: 'x' }, target: { entityType: 'todo', entityId: 'y' }, relation: 'references',
    })));
    const n = await asScoped(() => kg.neighbors(OWN_PROJECT.toString(), 'todo', 'a'));
    assert.equal(n.length, 1);
  });

  // ---- snippets ---------------------------------------------------------------
  const snip = (owner, title) => ({ _id: oid(), ...owner, title });
  const snipOwn = snip({ projectId: OWN_PROJECT }, 'own');
  const snipForeign = snip({ projectId: FOREIGN_PROJECT }, 'foreign');
  const snipForeignCustomer = snip({ customerId: FOREIGN_CUSTOMER }, 'foreign customer');
  const snipRelation = snip({ projectId: OWN_PROJECT, customerId: FOREIGN_CUSTOMER }, 'relation');
  const snippetModel = makeModel([snipOwn, snipForeign, snipForeignCustomer, snipRelation]);
  const snippets = new SnippetsService(snippetModel, emitter);

  await check('snippets: search without owner and findByProject only return in-scope snippets', async () => {
    const hits = await asScoped(() => snippets.search('x'));
    assert.deepEqual(hits.map((s) => s.title), ['own']);
    const byProject = await asScoped(() => snippets.findByProject(OWN_PROJECT.toString()));
    assert.deepEqual(byProject.map((s) => s.title), ['own'], 'relation snippet with foreign customer is hidden');
    await assert.rejects(() => asScoped(() => snippets.findByCustomer(FOREIGN_CUSTOMER.toString())), is403);
    await assert.rejects(() => asScoped(() => snippets.search('x', undefined, FOREIGN_CUSTOMER.toString())), is403);
    assert.equal((await snippets.search('x')).length, 4, 'internal caller sees everything');
  });

  await check('snippets: foreign get/update/delete -> 403; create for foreign customer -> 403', async () => {
    for (const s of [snipForeign, snipForeignCustomer, snipRelation]) {
      const id = String(s._id);
      await expect403NoMutation(() => asScoped(() => snippets.findById(id)));
      await expect403NoMutation(() => asScoped(() => snippets.update(id, { title: 'pwned' })));
      await expect403NoMutation(() => asScoped(() => snippets.remove(id)));
    }
    await expect403NoMutation(() => asScoped(() => snippets.create({ customerId: FOREIGN_CUSTOMER.toString(), title: 't', code: 'c', language: 'js' })));
    const created = await asScoped(() => snippets.create({ customerId: OWN_CUSTOMER.toString(), title: 't', code: 'c', language: 'js' }));
    assert.ok(created._id);
  });

  // ---- milestones -------------------------------------------------------------
  const clOwn = { _id: oid(), projectId: OWN_PROJECT, changes: ['own'] };
  const clOwn2 = { _id: oid(), projectId: OWN_PROJECT, changes: ['own 2'] };
  const clForeign = { _id: oid(), projectId: FOREIGN_PROJECT, changes: ['foreign'] };
  const changelogModel = makeModel([clOwn, clOwn2, clForeign]);
  const msOwn = { _id: oid(), projectId: OWN_PROJECT, name: 'own ms', number: 1, displayNumber: 'M-1', status: 'open' };
  const msForeign = {
    _id: oid(), projectId: FOREIGN_PROJECT, name: 'SECRET FOREIGN MILESTONE', number: 1, displayNumber: 'M-1',
    status: 'done', changelogId: clOwn2._id,
  };
  const milestoneModel = makeModel([msOwn, msForeign]);
  const projectModel = makeModel([{ _id: OWN_PROJECT, name: 'own' }, { _id: FOREIGN_PROJECT, name: 'foreign' }]);
  const counters = { getNextSequence: async () => 2 };
  let todoCreates = 0;
  const todosService = { findAll: async () => [], create: async () => { todoCreates += 1; return {}; } };
  const chatLlm = { getEndpoints: async () => [] };
  const milestones = new MilestonesService(milestoneModel, changelogModel, projectModel, counters, emitter, todosService, chatLlm);

  await check('milestones: foreign get/update/delete/export/ai-complete -> 403 without mutation', async () => {
    const id = String(msForeign._id);
    await expect403NoMutation(() => asScoped(() => milestones.findById(id)));
    await expect403NoMutation(() => asScoped(() => milestones.update(id, { name: 'pwned' })));
    await expect403NoMutation(() => asScoped(() => milestones.remove(id)));
    await expect403NoMutation(() => asScoped(() => milestones.exportAsMarkdown(id)));
    await expect403NoMutation(() => asScoped(() => milestones.aiComplete(id, 'summary')));
    assert.equal(milestoneModel._store.get(id).name, 'SECRET FOREIGN MILESTONE');
  });

  await check('milestones: list/resolve by number/create/import in a foreign project -> 403', async () => {
    const p = FOREIGN_PROJECT.toString();
    await assert.rejects(() => asScoped(() => milestones.findByProject(p)), is403);
    await assert.rejects(() => asScoped(() => milestones.resolveId({ projectId: p, number: '1' })), is403);
    await assert.rejects(() => asScoped(() => milestones.resolveId({ projectId: p, number: 'M-1' })), is403);
    await expect403NoMutation(() => asScoped(() => milestones.create({ projectId: p, name: 'x' })));
    todoCreates = 0;
    await expect403NoMutation(() => asScoped(() => milestones.importFromParsed(p, { name: 'x', todos: [{ title: 't' }] })));
    assert.equal(todoCreates, 0);
    const resolved = await asScoped(() => milestones.resolveId({ projectId: OWN_PROJECT.toString(), number: '1' }));
    assert.equal(resolved, String(msOwn._id));
  });

  await check('milestones: foreign changelog cannot be linked; conflict message hides foreign milestone name', async () => {
    const id = String(msOwn._id);
    reset();
    await assert.rejects(
      () => asScoped(() => milestones.update(id, { changelogId: String(clForeign._id) })),
      (e) => statusOf(e) === 400,
    );
    assert.equal(counter.writes, 0);
    await assert.rejects(
      () => asScoped(() => milestones.update(id, { changelogId: String(clOwn2._id) })),
      (e) => statusOf(e) === 400 && !String(e.message).includes('SECRET FOREIGN MILESTONE'),
    );
    const ok = await asScoped(() => milestones.update(id, { changelogId: String(clOwn._id) }));
    assert.equal(String(ok.changelogId), String(clOwn._id));
  });

  // ---- changelog / features ---------------------------------------------------
  const clService = new ChangelogService(changelogModel, emitter);
  const featOwn = { _id: oid(), projectId: OWN_PROJECT, name: 'own' };
  const featForeign = { _id: oid(), projectId: FOREIGN_PROJECT, name: 'foreign' };
  const features = new FeaturesService(makeModel([featOwn, featForeign]), emitter);

  await check('changelog + features: foreign get/update/delete/list/create -> 403', async () => {
    const p = FOREIGN_PROJECT.toString();
    for (const [svc, foreign, upd] of [[clService, clForeign, { summary: 'x' }], [features, featForeign, { name: 'x' }]]) {
      const id = String(foreign._id);
      await expect403NoMutation(() => asScoped(() => svc.findById(id)));
      await expect403NoMutation(() => asScoped(() => svc.update(id, upd)));
      await expect403NoMutation(() => asScoped(() => svc.remove(id)));
      await assert.rejects(() => asScoped(() => svc.findByProject(p)), is403);
      await expect403NoMutation(() => asScoped(() => svc.create({ projectId: p, name: 'x', changes: ['x'] })));
    }
    const own = await asScoped(() => features.findById(String(featOwn._id)));
    assert.equal(own.name, 'own');
  });

  // ---- manuals ----------------------------------------------------------------
  const manOwn = { _id: oid(), projectId: OWN_PROJECT, title: 'own' };
  const manForeign = { _id: oid(), projectId: FOREIGN_PROJECT, title: 'foreign' };
  const manRelation = { _id: oid(), projectId: OWN_PROJECT, customerId: FOREIGN_CUSTOMER, title: 'relation' };
  let customerLookups = 0;
  const manuals = new ManualsService(makeModel([manOwn, manForeign, manRelation]), { findById: async () => { customerLookups += 1; return {}; } }, emitter);

  await check('manuals: foreign get/update/delete -> 403; relation hidden; foreign owner params -> 403', async () => {
    for (const m of [manForeign, manRelation]) {
      const id = String(m._id);
      await expect403NoMutation(() => asScoped(() => manuals.findById(id)));
      await expect403NoMutation(() => asScoped(() => manuals.update(id, { title: 'pwned' })));
      await expect403NoMutation(() => asScoped(() => manuals.delete(id)));
    }
    const list = await asScoped(() => manuals.findByProject(OWN_PROJECT.toString()));
    assert.deepEqual(list.map((m) => m.title), ['own']);
    await assert.rejects(() => asScoped(() => manuals.findByCustomer(FOREIGN_CUSTOMER.toString())), is403);
    customerLookups = 0;
    await expect403NoMutation(() => asScoped(() => manuals.create({ customerId: FOREIGN_CUSTOMER.toString(), title: 't', content: 'c' })));
    await expect403NoMutation(() => asScoped(() => manuals.create({ projectId: FOREIGN_PROJECT.toString(), title: 't', content: 'c' })));
    assert.equal(customerLookups, 0, 'scope is checked before the customer lookup');
  });

  await check('internal callers (no actor) still reach foreign entities in every service', async () => {
    assert.ok(await kg.findById(String(foreignEdge._id)));
    assert.ok(await snippets.findById(String(snipRelation._id)));
    assert.ok(await milestones.findById(String(msForeign._id)));
    assert.ok(await clService.findById(String(clForeign._id)));
    assert.ok(await features.findById(String(featForeign._id)));
    assert.ok(await manuals.findById(String(manRelation._id)));
    assert.equal((await manuals.findByProject(OWN_PROJECT.toString())).length, 2);
  });

  await check('invalid ids -> 404 instead of a cast error', async () => {
    for (const fn of [
      () => kg.findById('nope'), () => snippets.findById('nope'), () => milestones.findById('nope'),
      () => clService.findById('nope'), () => features.findById('nope'), () => manuals.findById('nope'),
    ]) {
      await assert.rejects(fn, (e) => statusOf(e) === 404);
    }
    await assert.rejects(() => kg.list({ projectId: 'nope' }), (e) => statusOf(e) === 400);
  });

  if (total !== EXPECTED_CHECKS) {
    console.error(`✗ expected ${EXPECTED_CHECKS} checks, ran ${total}`);
    failures += 1;
  }
  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
})();
