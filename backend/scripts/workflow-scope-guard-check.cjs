#!/usr/bin/env node
/**
 * Scope-Wächter der Workflow-Läufe (Link-Modell- und Audit-Attrappe, kein Mongo)
 * und die nachgerüsteten Todo-Nodes. Nach `npm run build` ausführen.
 */
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { WorkflowScopeGuard } = require('../dist/workflows/workflow-scope.guard');
const { ActionTodoUpdateExecutor } = require('../dist/workflows/nodes/action-todo-update.executor');
const { ActionTodoCommentExecutor } = require('../dist/workflows/nodes/action-todo-comment.executor');
const { ActionTodoLinkMilestoneExecutor } = require('../dist/workflows/nodes/action-todo-link-milestone.executor');

const milestones = { findById: async (id) => ({ projectId: id === 'mForeign' ? P2 : P1 }) };
const P1 = new Types.ObjectId();
const P2 = new Types.ObjectId();
const C = new Types.ObjectId();

function makeGuard(links) {
  const filters = [];
  const model = {
    find(filter) {
      filters.push(filter);
      const rows = links.filter(
        (l) =>
          (!filter.projectId || l.projectId.equals(filter.projectId)) &&
          (!filter.customerId || l.customerId.equals(filter.customerId)) &&
          filter.status.$in.includes(l.status),
      );
      const q = { select: () => q, lean: () => q, exec: async () => rows };
      return q;
    },
  };
  const audits = [];
  const audit = { record: async (e) => void audits.push(e) };
  return { guard: new WorkflowScopeGuard(model, audit), filters, audits };
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL ${name}\n`, err);
    process.exitCode = 1;
  }
}

(async () => {
  const link = (status) => [{ customerId: C, projectId: P1, status }];

  await check('Projekt-Lauf: Todo im eigenen Projekt', async () => {
    const { guard } = makeGuard([]);
    assert.equal(await guard.check({ projectId: P1 }, { projectId: P1 }), true);
  });
  await check('Projekt-Lauf: Todo in fremdem Projekt', async () => {
    const { guard } = makeGuard([]);
    assert.equal(await guard.check({ projectId: P1 }, { projectId: P2 }), false);
  });
  await check('verlinkter Kunde (active/paused) zählt, archived nicht', async () => {
    for (const [status, expected] of [['active', true], ['paused', true], ['archived', false]]) {
      const { guard } = makeGuard(link(status));
      assert.equal(await guard.check({ projectId: P1 }, { customerId: C }), expected, status);
    }
  });
  await check('Kunden-Lauf: Todo in verlinktem Projekt', async () => {
    const { guard } = makeGuard(link('active'));
    assert.equal(await guard.check({ customerId: C }, { projectId: P1 }), true);
    assert.equal(await guard.check({ customerId: C }, { projectId: P2 }), false);
  });
  await check('Entität ohne beide IDs', async () => {
    const { guard } = makeGuard(link('active'));
    assert.equal(await guard.check({ projectId: P1 }, {}), false);
    assert.equal(await guard.check({ projectId: P1 }, { projectId: undefined, customerId: null }), false);
  });
  await check('System-Scope: leere Listen, keine Abfrage', async () => {
    const { guard, filters } = makeGuard(link('active'));
    assert.deepEqual(await guard.allowedOwners({}), { projectIds: [], customerIds: [] });
    assert.equal(await guard.check({}, { projectId: P1 }), false);
    assert.equal(filters.length, 0);
  });
  await check('allowedOwners: Strings, Filter nur mit ObjectIds', async () => {
    const { guard, filters } = makeGuard(link('paused'));
    const o = await guard.allowedOwners({ projectId: P1 });
    assert.deepEqual(o, { projectIds: [P1.toString()], customerIds: [C.toString()] });
    assert.ok(filters[0].projectId instanceof Types.ObjectId);
  });

  // Todo-Nodes: bei Verstoß wird nicht geschrieben, Audit + Fehlercode.
  for (const [Cls, cfg] of [
    [ActionTodoUpdateExecutor, { todoId: 't1', status: 'in_progress' }],
    [ActionTodoCommentExecutor, { todoId: 't1', text: 'x' }],
    [ActionTodoLinkMilestoneExecutor, { todoId: 't1', milestoneId: 'm1' }],
  ]) {
    await check(`${Cls.name}: scope_violation ohne Schreibzugriff`, async () => {
      const { guard, audits } = makeGuard([]);
      let wrote = false;
      const todos = {
        findById: async () => ({ projectId: P2 }),
        update: async () => void (wrote = true),
        addComment: async () => void (wrote = true),
      };
      const run = { _id: new Types.ObjectId(), projectId: P1 };
      const res = await new Cls(todos, guard, milestones).execute({ run, node: { id: 'n1' }, config: cfg, runContext: {} });
      assert.equal(res.status, 'failed');
      assert.equal(res.error.code, 'scope_violation');
      assert.ok(!res.error.message.includes(P2.toString()));
      assert.equal(wrote, false);
      assert.equal(audits[0].action, 'workflow.permission.denied');
      assert.equal(audits[0].meta.nodeId, 'n1');
      assert.deepEqual(audits[0].meta.entity, { type: 'todo', id: 't1' });
    });
    await check(`${Cls.name}: im Scope wird geschrieben`, async () => {
      const { guard } = makeGuard([]);
      let wrote = false;
      const todos = {
        findById: async () => ({ projectId: P1 }),
        update: async () => void (wrote = true),
        addComment: async () => void (wrote = true),
      };
      const run = { _id: new Types.ObjectId(), projectId: P1 };
      const res = await new Cls(todos, guard, milestones).execute({ run, node: { id: 'n1' }, config: cfg, runContext: {} });
      assert.equal(res.status, 'success');
      assert.equal(wrote, true);
    });
  }

  for (const [Cls, cfg] of [
    [ActionTodoUpdateExecutor, { todoId: 't1', milestoneId: 'mForeign' }],
    [ActionTodoLinkMilestoneExecutor, { todoId: 't1', milestoneId: 'mForeign' }],
  ]) {
    await check(`${Cls.name}: fremder Milestone -> scope_violation ohne Schreibzugriff`, async () => {
      const { guard, audits } = makeGuard([]);
      let wrote = false;
      const todos = { findById: async () => ({ projectId: P1 }), update: async () => void (wrote = true) };
      const run = { _id: new Types.ObjectId(), projectId: P1 };
      const res = await new Cls(todos, guard, milestones).execute({ run, node: { id: 'n1' }, config: cfg, runContext: {} });
      assert.equal(res.error.code, 'scope_violation');
      assert.equal(wrote, false);
      assert.deepEqual(audits[0].meta.entity, { type: 'milestone', id: 'mForeign' });
    });
  }

  console.log(`workflow-scope-guard-check: ${passed} Prüfungen bestanden`);
})();
