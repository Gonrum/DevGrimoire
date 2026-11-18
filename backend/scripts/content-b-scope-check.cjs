#!/usr/bin/env node
/*
 * Scope check for the content services: dependencies, DB-schema docs,
 * releases, sessions, knowledge, todos, attachments.
 *
 * Pins, for an actor narrowed to ONE project + ONE customer:
 *   - by-id read/update/delete of a foreign entity -> 403, nothing written
 *   - list-by-project / create / bulk create with a foreign projectId -> 403
 *   - schema versions are guarded by their parent schema
 *   - knowledge: global entries (explicit or owner-less) are read-only for a
 *     narrowed actor; a foreign customerId riding along on create -> 403
 *   - todos: milestoneId / blockedBy must belong to the todo's own owner;
 *     create with a foreign project -> 403
 *   - attachments: foreign projectId -> 403 BEFORE putObject
 *   - no actor (internal caller) still works everywhere
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
const { DependenciesService } = loadCompiled('dependencies/dependencies.service.js');
const { SchemasService } = loadCompiled('schemas/schemas.service.js');
const { ReleasesService } = loadCompiled('releases/releases.service.js');
const { SessionsService } = loadCompiled('sessions/sessions.service.js');
const { KnowledgeService } = loadCompiled('knowledge/knowledge.service.js');
const { TodosService } = loadCompiled('todos/todos.service.js');
const { AttachmentsService } = loadCompiled('attachments/attachments.service.js');
const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const EXPECTED_CHECKS = 10;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const oid = () => new mongoose.Types.ObjectId();
const OWN_P = oid();
const FOREIGN_P = oid();
const OWN_C = oid();
const FOREIGN_C = oid();

function asScoped(fn) {
  return RequestContext.run({
    userId: 'u-scoped', username: 'scoped', role: 'user',
    projectScopeMode: 'allowlist', allowedProjectIds: [String(OWN_P)],
    customerScopeMode: 'allowlist', allowedCustomerIds: [String(OWN_C)],
  }, undefined, fn);
}

const noopEmitter = { emit: () => true };

/** Value matcher understanding the `{ $in: [...] }` shape of projectIdFilter. */
function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    const actual = doc[k];
    if (v && typeof v === 'object' && Array.isArray(v.$in)) {
      return v.$in.some((x) => String(x) === String(actual));
    }
    return String(v) === String(actual);
  });
}

/**
 * In-memory model with the chains the services use. `counter.writes` proves
 * that a rejected call changed NOTHING — a check running after the mutation
 * would otherwise be just as green.
 */
function makeModel(docs, counter) {
  const store = new Map(docs.map((d) => [String(d._id), d]));
  const q = (val) => {
    const chain = { sort: () => chain, skip: () => chain, limit: () => chain, select: () => chain, lean: () => chain, exec: async () => val };
    return chain;
  };
  return {
    _store: store,
    findById: (id) => q(store.get(String(id)) || null),
    find: (filter = {}) => q([...store.values()].filter((d) => matches(d, filter))),
    findOne: (filter = {}) => q([...store.values()].find((d) => matches(d, filter)) || null),
    exists: (filter) => q([...store.values()].some((d) => matches(d, filter)) ? { _id: 1 } : null),
    countDocuments: (filter) => {
      const { _id, ...rest } = filter;
      const ids = _id && _id.$in ? _id.$in.map(String) : null;
      return q([...store.values()].filter((d) => (!ids || ids.includes(String(d._id))) && matches(d, rest)).length);
    },
    findByIdAndUpdate: (id, upd) => {
      counter.writes += 1;
      const d = store.get(String(id));
      if (d) Object.assign(d, upd);
      return q(d || null);
    },
    findByIdAndDelete: (id) => {
      counter.writes += 1;
      const d = store.get(String(id));
      store.delete(String(id));
      return q(d || null);
    },
    deleteOne: (f) => { counter.writes += 1; store.delete(String(f._id)); return q({}); },
    deleteMany: () => { counter.writes += 1; return q({}); },
    updateOne: async () => { counter.writes += 1; return { upsertedCount: 1, matchedCount: 0 }; },
    create: async (data) => {
      counter.writes += 1;
      const d = { _id: oid(), ...data };
      store.set(String(d._id), d);
      return d;
    },
  };
}

async function expectForbidden(label, counter, fn) {
  const before = counter.writes;
  const err = await Promise.resolve().then(fn).then(() => null, (e) => e);
  assert.ok(err, `${label}: foreign access was NOT rejected`);
  assert.equal(typeof err.getStatus, 'function', `${label}: expected an HttpException, got ${err}`);
  assert.equal(err.getStatus(), 403, `${label}: expected 403, got ${err.getStatus()}`);
  assert.equal(counter.writes, before, `${label}: something was written — the check runs AFTER the mutation`);
}

async function expectBadRequest(label, counter, fn) {
  const before = counter.writes;
  const err = await Promise.resolve().then(fn).then(() => null, (e) => e);
  assert.ok(err, `${label}: was NOT rejected`);
  assert.equal(err.getStatus && err.getStatus(), 400, `${label}: expected 400, got ${err}`);
  assert.equal(counter.writes, before, `${label}: something was written`);
}

/** Generic project-bound CRUD service check (dependencies, schemas, releases). */
async function crudCheck(name, build, createDto) {
  const counter = { writes: 0 };
  const own = { _id: oid(), projectId: OWN_P, name: 'own', version: '1' };
  const foreign = { _id: oid(), projectId: FOREIGN_P, name: 'foreign', version: '1' };
  const model = makeModel([own, foreign], counter);
  const svc = build(model);
  await asScoped(async () => {
    await expectForbidden(`${name}.findById`, counter, () => svc.findById(String(foreign._id)));
    await expectForbidden(`${name}.update`, counter, () => svc.update(String(foreign._id), { description: 'x' }));
    await expectForbidden(`${name}.remove`, counter, () => svc.remove(String(foreign._id)));
    await expectForbidden(`${name}.findByProject`, counter, () => svc.findByProject(String(FOREIGN_P)));
    await expectForbidden(`${name}.create`, counter, () => svc.create({ ...createDto, projectId: String(FOREIGN_P) }));
    assert.ok(model._store.has(String(foreign._id)), `${name}: foreign entity was deleted`);
    // Own entities keep working.
    assert.equal(String((await svc.findById(String(own._id)))._id), String(own._id));
    await svc.findByProject(String(OWN_P));
  });
  // Internal caller (no actor) is not restricted.
  assert.equal(String((await svc.findById(String(foreign._id)))._id), String(foreign._id));
  return { svc, counter, own, foreign };
}

(async () => {
  await check('dependencies: by-id, list, create, bulk create are scoped', async () => {
    const { svc, counter } = await crudCheck('dependencies', (m) => new DependenciesService(m, noopEmitter),
      { name: 'x', version: '1', packageManager: 'npm' });
    await asScoped(() => expectForbidden('dependencies.bulkCreate', counter, () =>
      svc.bulkCreate({ projectId: String(FOREIGN_P), packageManager: 'npm', dependencies: [{ name: 'a', version: '1' }] })));
  });

  await check('schemas: by-id, list, create are scoped; versions follow the parent', async () => {
    const counter = { writes: 0 };
    const versionModel = makeModel([], counter);
    const { svc, foreign, own } = await crudCheck('schemas', (m) => new SchemasService(m, versionModel, noopEmitter),
      { name: 'x', dbType: 'mongodb' });
    await asScoped(async () => {
      await expectForbidden('schemas.getVersions', counter, () => svc.getVersions(String(foreign._id)));
      await expectForbidden('schemas.getVersion', counter, () => svc.getVersion(String(foreign._id), 1));
      await svc.getVersions(String(own._id));
    });
  });

  await check('releases: by-id, list, create, sync are scoped', async () => {
    let projectLoaded = false;
    const { svc, counter } = await crudCheck('releases', (m) => new ReleasesService(m, noopEmitter,
      { findById: async () => { projectLoaded = true; return { toObject: () => ({ gitRepositories: [] }) }; } }, {}, {}),
    { version: '9.9.9' });
    await asScoped(() => expectForbidden('releases.syncReleases', counter, () => svc.syncReleases(String(FOREIGN_P))));
    assert.equal(projectLoaded, false, 'sync loaded the foreign project before the scope check');
  });

  await check('sessions: list, latest, by-id, create are scoped', async () => {
    const counter = { writes: 0 };
    const foreign = { _id: oid(), projectId: FOREIGN_P, summary: 'foreign' };
    const own = { _id: oid(), projectId: OWN_P, summary: 'own' };
    const svc = new SessionsService(makeModel([own, foreign], counter), noopEmitter);
    await asScoped(async () => {
      await expectForbidden('sessions.findById', counter, () => svc.findById(String(foreign._id)));
      await expectForbidden('sessions.findByProject', counter, () => svc.findByProject(String(FOREIGN_P)));
      await expectForbidden('sessions.findLatest', counter, () => svc.findLatest(String(FOREIGN_P)));
      await expectForbidden('sessions.create', counter, () => svc.create({ projectId: String(FOREIGN_P), summary: 'x' }));
      assert.equal(String((await svc.findLatest(String(OWN_P)))._id), String(own._id));
    });
    assert.equal(String((await svc.findById(String(foreign._id)))._id), String(foreign._id));
  });

  await check('knowledge: global entries are read-only for a narrowed actor', async () => {
    const counter = { writes: 0 };
    const global = { _id: oid(), scope: 'global', topic: 'g' };
    const ownerless = { _id: oid(), scope: 'project', topic: 'legacy' };
    const own = { _id: oid(), scope: 'project', projectId: OWN_P, topic: 'own' };
    const model = makeModel([global, ownerless, own], counter);
    const svc = new KnowledgeService(model, { findById: async () => ({}) }, noopEmitter);
    await asScoped(async () => {
      // Reading stays allowed — global knowledge is meant to be visible.
      assert.equal(String((await svc.findById(String(global._id)))._id), String(global._id));
      await expectForbidden('knowledge.create global', counter, () => svc.create({ scope: 'global', topic: 't', content: 'c' }));
      await expectForbidden('knowledge.create implicit global', counter, () => svc.create({ topic: 't', content: 'c' }));
      await expectForbidden('knowledge.update global', counter, () => svc.update(String(global._id), { content: 'x' }));
      await expectForbidden('knowledge.update owner-less', counter, () => svc.update(String(ownerless._id), { content: 'x' }));
      await expectForbidden('knowledge.remove global', counter, () => svc.remove(String(global._id)));
      await svc.update(String(own._id), { content: 'ok' });
    });
    // Internal caller may still maintain global knowledge.
    await svc.create({ scope: 'global', topic: 't', content: 'c' });
    await svc.update(String(global._id), { content: 'internal' });
  });

  await check('knowledge: create checks every owner id that is present', async () => {
    const counter = { writes: 0 };
    const svc = new KnowledgeService(makeModel([], counter), { findById: async () => ({}) }, noopEmitter);
    await asScoped(async () => {
      await expectForbidden('knowledge.create foreign project', counter, () =>
        svc.create({ scope: 'project', projectId: String(FOREIGN_P), topic: 't', content: 'c' }));
      await expectForbidden('knowledge.create project + foreign customer', counter, () =>
        svc.create({ scope: 'project', projectId: String(OWN_P), customerId: String(FOREIGN_C), topic: 't', content: 'c' }));
      await expectForbidden('knowledge.create foreign customer', counter, () =>
        svc.create({ scope: 'customer', customerId: String(FOREIGN_C), topic: 't', content: 'c' }));
      await svc.create({ scope: 'project', projectId: String(OWN_P), topic: 't', content: 'c' });
      await svc.create({ scope: 'customer', customerId: String(OWN_C), topic: 't', content: 'c' });
    });
  });

  await check('todos: create with a foreign project and number lookups are scoped', async () => {
    const counter = { writes: 0 };
    const todoModel = makeModel([{ _id: oid(), projectId: FOREIGN_P, number: 1, displayNumber: 'T-1' }], counter);
    const projectModel = makeModel([{ _id: OWN_P, name: 'own' }, { _id: FOREIGN_P, name: 'foreign' }], counter);
    const svc = new TodosService(todoModel, projectModel, { getNextSequence: async () => 1 },
      { findById: async () => ({}) }, noopEmitter, { countOpenForTodo: async () => ({ count: 0, items: [] }) },
      makeModel([], counter));
    await asScoped(async () => {
      await expectForbidden('todos.create foreign project', counter, () => svc.create({ projectId: String(FOREIGN_P), title: 't' }));
      await expectForbidden('todos.create foreign customer', counter, () => svc.create({ customerId: String(FOREIGN_C), title: 't' }));
      await expectForbidden('todos.findByNumber', counter, () => svc.findByNumber(String(FOREIGN_P), 1));
      await expectForbidden('todos.findByDisplayNumber', counter, () => svc.findByDisplayNumber(String(FOREIGN_P), 'T-1'));
      await svc.create({ projectId: String(OWN_P), title: 't' });
    });
  });

  await check('todos: milestoneId and blockedBy must stay inside the todo owner', async () => {
    const counter = { writes: 0 };
    const ownTodo = { _id: oid(), projectId: OWN_P, status: 'open', title: 'own' };
    const ownBlocker = { _id: oid(), projectId: OWN_P, status: 'open', title: 'b' };
    const foreignTodo = { _id: oid(), projectId: FOREIGN_P, status: 'open', title: 'f' };
    const custTodo = { _id: oid(), customerId: OWN_C, status: 'open', title: 'c' };
    const ownMs = { _id: oid(), projectId: OWN_P };
    const foreignMs = { _id: oid(), projectId: FOREIGN_P };
    const todoModel = makeModel([ownTodo, ownBlocker, foreignTodo, custTodo], counter);
    const svc = new TodosService(todoModel, makeModel([{ _id: OWN_P, name: 'own' }], counter),
      { getNextSequence: async () => 2 }, { findById: async () => ({}) }, noopEmitter,
      { countOpenForTodo: async () => ({ count: 0, items: [] }) }, makeModel([ownMs, foreignMs], counter));
    const run = async () => {
      await expectBadRequest('update foreign milestone', counter, () => svc.update(String(ownTodo._id), { milestoneId: String(foreignMs._id) }));
      await expectBadRequest('update foreign blocker', counter, () => svc.update(String(ownTodo._id), { blockedBy: [String(foreignTodo._id)] }));
      await expectBadRequest('update unknown blocker', counter, () => svc.update(String(ownTodo._id), { blockedBy: [String(oid())] }));
      await expectBadRequest('update invalid milestone id', counter, () => svc.update(String(ownTodo._id), { milestoneId: 'nope' }));
      await expectBadRequest('customer todo with milestone', counter, () => svc.update(String(custTodo._id), { milestoneId: String(ownMs._id) }));
      await expectBadRequest('create foreign milestone', counter, () => svc.create({ projectId: String(OWN_P), title: 't', milestoneId: String(foreignMs._id) }));
      await expectBadRequest('create foreign blocker', counter, () => svc.create({ projectId: String(OWN_P), title: 't', blockedBy: [String(foreignTodo._id)] }));
      await svc.update(String(ownTodo._id), { milestoneId: String(ownMs._id), blockedBy: [String(ownBlocker._id)] });
    };
    // Applies to the narrowed actor AND to internal callers: the reference
    // rule is about data integrity, later jobs resolve the ids unchecked.
    await asScoped(run);
    await run();
  });

  await check('attachments: foreign projectId is rejected before putObject', async () => {
    const counter = { writes: 0 };
    let puts = 0;
    const svc = new AttachmentsService(makeModel([], counter),
      { putObject: async () => { puts += 1; } }, { findById: async () => ({}) }, noopEmitter);
    const file = { buffer: Buffer.from('hello'), originalname: 'a.bin', mimetype: 'application/octet-stream' };
    await asScoped(async () => {
      await expectForbidden('attachments.create foreign project', counter, () => svc.create({ projectId: String(FOREIGN_P) }, file));
      await expectForbidden('attachments.create foreign customer', counter, () => svc.create({ customerId: String(FOREIGN_C) }, file));
      await expectForbidden('attachments.createFromBase64 foreign project', counter, () =>
        svc.createFromBase64({ projectId: String(FOREIGN_P), fileName: 'a.bin' }, Buffer.from('x').toString('base64')));
      assert.equal(puts, 0, 'an object was stored in MinIO for a foreign owner');
      await svc.create({ projectId: String(OWN_P) }, file);
      assert.equal(puts, 1);
    });
    await expectBadRequest('attachments.create non-ObjectId projectId', counter, () => svc.create({ projectId: '../x' }, file));
  });

  await check('internal caller (no actor) is unrestricted for lists', async () => {
    const counter = { writes: 0 };
    const svc = new DependenciesService(makeModel([{ _id: oid(), projectId: FOREIGN_P, name: 'f' }], counter), noopEmitter);
    const list = await svc.findByProject(String(FOREIGN_P));
    assert.equal(list.length, 1);
  });

  if (total !== EXPECTED_CHECKS) {
    console.error(`✗ expected ${EXPECTED_CHECKS} checks, ran ${total}`);
    failures += 1;
  }
  console.log(failures === 0 ? `\nAll ${total} checks passed.` : `\n${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
})();
