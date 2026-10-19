#!/usr/bin/env node
/**
 * Node `todo.find` und TodosService.findForWorkflow gegen eine Attrappe des
 * Todo-Modells (kein Mongo). Nach `npm run build`.
 */
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { TodosService } = require('../dist/todos/todos.service');
const { TodoFindExecutor } = require('../dist/workflows/nodes/todo-find.executor');

const P1 = new Types.ObjectId().toString();
const C1 = new Types.ObjectId().toString();

function makeModel(rows = []) {
  const calls = [];
  const model = {
    calls,
    find(filter) {
      const call = { filter, sort: undefined, limit: undefined };
      calls.push(call);
      const q = {
        sort(s) { call.sort = s; return q; },
        limit(n) { call.limit = n; return q; },
        exec: async () => rows.filter((r) => !call.filter.priority || r.priority === call.filter.priority).slice(0, call.limit),
      };
      return q;
    },
  };
  return model;
}
const service = (model) => new TodosService(model, {}, {}, {}, {}, {});
const base = { projectIds: [P1], customerIds: [], statuses: ['open'], sort: 'oldest', limit: 1 };

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + (e && e.stack)); }
}

(async () => {
  await check('oldest -> sort createdAt 1, limit 1, archived ausgeschlossen', async () => {
    const m = makeModel([{ n: 1 }]);
    await service(m).findForWorkflow(base);
    assert.deepEqual(m.calls[0].sort, { createdAt: 1 });
    assert.equal(m.calls[0].limit, 1);
    assert.deepEqual(m.calls[0].filter.archived, { $ne: true });
    assert.deepEqual(m.calls[0].filter.status, { $in: ['open'] });
    assert.equal(m.calls[0].filter.$and[0].$or.length, 1);
  });
  await check('newest -> createdAt -1', async () => {
    const m = makeModel();
    await service(m).findForWorkflow({ ...base, sort: 'newest', limit: 5 });
    assert.deepEqual(m.calls[0].sort, { createdAt: -1 });
    assert.equal(m.calls[0].limit, 5);
  });
  await check('leere Owner-Listen -> [] ohne Modellaufruf', async () => {
    const m = makeModel();
    assert.deepEqual(await service(m).findForWorkflow({ ...base, projectIds: [], customerIds: [] }), []);
    assert.deepEqual(await service(m).findForWorkflow({ ...base, projectIds: ['kaputt'] }), []);
    assert.equal(m.calls.length, 0);
  });
  await check('kaputte milestoneId -> [] ohne Modellaufruf', async () => {
    const m = makeModel();
    assert.deepEqual(await service(m).findForWorkflow({ ...base, milestoneId: 'x' }), []);
    assert.equal(m.calls.length, 0);
  });
  await check('Projekt und Kunde -> $or mit beiden', async () => {
    const m = makeModel();
    await service(m).findForWorkflow({ ...base, customerIds: [C1] });
    assert.equal(m.calls[0].filter.$and[0].$or.length, 2);
  });
  await check('sort priority -> stufenweise critical..low mit Restlimit', async () => {
    const m = makeModel([{ priority: 'high' }, { priority: 'low' }]);
    const res = await service(m).findForWorkflow({ ...base, sort: 'priority', limit: 2 });
    assert.deepEqual(m.calls.map((c) => c.filter.priority), ['critical', 'high', 'medium', 'low']);
    assert.deepEqual(res.map((r) => r.priority), ['high', 'low']);
  });
  await check('sort priority bricht ab, wenn Limit erreicht', async () => {
    const m = makeModel([{ priority: 'critical' }]);
    await service(m).findForWorkflow({ ...base, sort: 'priority', limit: 1 });
    assert.equal(m.calls.length, 1);
  });

  const run = { _id: new Types.ObjectId(), projectId: new Types.ObjectId(P1) };
  const guard = { allowedOwners: async () => ({ projectIds: [P1], customerIds: [] }) };
  const ctx = (config) => ({ run, config, runContext: {} });
  await check('Executor: 0 Treffer -> branch custom, todo null', async () => {
    const ex = new TodoFindExecutor({ findForWorkflow: async () => [] }, guard);
    const r = await ex.execute(ctx({}));
    assert.equal(r.status, 'success');
    assert.equal(r.branch, 'custom');
    assert.deepEqual(r.output, { todo: null, todos: [], count: 0 });
  });
  await check('Executor: Treffer -> success, Defaults, Ausgabeform', async () => {
    let q;
    const t = { _id: new Types.ObjectId(), number: 3, title: 'T', description: 'd', status: 'open', priority: 'high', tags: ['a'], createdAt: new Date(0) };
    const ex = new TodoFindExecutor({ findForWorkflow: async (x) => { q = x; return [t]; } }, guard);
    const r = await ex.execute(ctx({}));
    assert.equal(r.branch, 'success');
    assert.equal(r.output.count, 1);
    assert.equal(r.output.todo.number, 3);
    assert.equal(r.output.todo.id, t._id.toString());
    assert.deepEqual(q.statuses, ['open']);
    assert.equal(q.sort, 'oldest');
    assert.equal(q.limit, 1);
  });
  await check('Executor: ungültige Konfiguration -> failed invalid_config', async () => {
    const ex = new TodoFindExecutor({ findForWorkflow: async () => assert.fail('darf nicht laufen') }, guard);
    for (const bad of [{ limit: 0 }, { limit: 21 }, { statuses: ['nope'] }, { statuses: [] }]) {
      const r = await ex.execute(ctx(bad));
      assert.equal(r.status, 'failed');
      assert.equal(r.error.code, 'invalid_config');
    }
  });
  await check('Executor: Metadaten', () => {
    const ex = new TodoFindExecutor({}, guard);
    assert.equal(ex.metadata.category, 'control');
    assert.deepEqual(ex.metadata.branches, ['success', 'custom']);
  });

  // Final-Review I5: ein Projekt-Lauf sucht nur im eigenen Projekt, nicht in
  // den Todos der verlinkten Kunden; ein Kunden-Lauf im Kunden + verlinkten Projekten.
  const P2 = new Types.ObjectId().toString();
  const C2 = new Types.ObjectId().toString();
  await check('Executor: Projekt-Lauf -> nur eigenes Projekt, keine verlinkten Kunden', async () => {
    let q;
    const linkedGuard = { allowedOwners: async () => ({ projectIds: [P1], customerIds: [C1, C2] }) };
    const ex = new TodoFindExecutor({ findForWorkflow: async (x) => { q = x; return []; } }, linkedGuard);
    await ex.execute(ctx({}));
    assert.deepEqual(q.projectIds, [P1]);
    assert.deepEqual(q.customerIds, []);
  });
  await check('Executor: Kunden-Lauf -> eigener Kunde plus verlinkte Projekte', async () => {
    let q;
    const custRun = { _id: new Types.ObjectId(), customerId: new Types.ObjectId(C1) };
    const linkedGuard = { allowedOwners: async (r) => { assert.equal(r, custRun); return { projectIds: [P1, P2], customerIds: [C1] }; } };
    const ex = new TodoFindExecutor({ findForWorkflow: async (x) => { q = x; return []; } }, linkedGuard);
    await ex.execute({ run: custRun, config: {}, runContext: {} });
    assert.deepEqual(q.projectIds, [P1, P2]);
    assert.deepEqual(q.customerIds, [C1]);
  });
  await check('Executor: milestoneId ohne ref:milestone (kein UI-Handler, M5)', () => {
    const ex = new TodoFindExecutor({}, guard);
    assert.equal(ex.metadata.configSchema.shape.milestoneId.description, undefined);
  });

  if (failed) { console.log(failed + ' failed'); process.exit(1); }
  console.log('all ok');
})();
