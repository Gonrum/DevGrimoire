#!/usr/bin/env node
/*
 * Pure-logic regression check for the T-252 node catalog.
 * Loads compiled helpers from dist/ and exercises them.
 * Run with `npm run check:workflow-nodes-units` from backend/ after a build.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const tmpl = loadCompiled('workflows/nodes/template.js');
const condOps = loadCompiled('workflows/nodes/condition-ops.js');
const nodeMetadata = loadCompiled('workflows/engine/node-metadata.js');

let failures = 0;
let total = 0;

function check(label, fn) {
  total += 1;
  try {
    fn();
    console.log(`✓ ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err.message || err}`);
  }
}

// ---------- lookupPath ----------
check('lookupPath: top-level', () => {
  assert.equal(tmpl.lookupPath('name', { name: 'Anna' }), 'Anna');
});
check('lookupPath: nested', () => {
  assert.equal(tmpl.lookupPath('nodes.x.id', { nodes: { x: { id: 'abc' } } }), 'abc');
});
check('lookupPath: missing returns undefined', () => {
  assert.equal(tmpl.lookupPath('missing.thing', {}), undefined);
});

// ---------- condition-ops ----------
check('evalOp eq truthy', () => assert.equal(condOps.evalOp(5, 'eq', 5), true));
check('evalOp eq falsy', () => assert.equal(condOps.evalOp(5, 'eq', 6), false));
check('evalOp ne truthy', () => assert.equal(condOps.evalOp(5, 'ne', 6), true));
check('evalOp gt numeric', () => assert.equal(condOps.evalOp(10, 'gt', 5), true));
check('evalOp gt rejects strings', () => assert.equal(condOps.evalOp('a', 'gt', 'b'), false));
check('evalOp lt numeric', () => assert.equal(condOps.evalOp(3, 'lt', 5), true));
check('evalOp gte / lte edges', () => {
  assert.equal(condOps.evalOp(5, 'gte', 5), true);
  assert.equal(condOps.evalOp(5, 'lte', 5), true);
});
check('evalOp contains on string', () => assert.equal(condOps.evalOp('hello', 'contains', 'ell'), true));
check('evalOp contains on array', () => assert.equal(condOps.evalOp(['a', 'b'], 'contains', 'b'), true));
check('evalOp exists', () => {
  assert.equal(condOps.evalOp(0, 'exists'), true);
  assert.equal(condOps.evalOp(null, 'exists'), false);
  assert.equal(condOps.evalOp(undefined, 'exists'), false);
});
check('evalOp truthy', () => {
  assert.equal(condOps.evalOp(0, 'truthy'), false);
  assert.equal(condOps.evalOp('x', 'truthy'), true);
  assert.equal(condOps.evalOp([], 'truthy'), true);
});

// ---------- NodeMetadata + zod schemas ----------
const allExecutors = [
  ['workflows/nodes/trigger-manual.executor.js', 'TriggerManualExecutor', { config: {}, invalid: { extra: true } }],
  ['workflows/nodes/trigger-schedule.executor.js', 'TriggerScheduleExecutor', { config: {}, invalid: null }],
  ['workflows/nodes/action-log.executor.js', 'ActionLogExecutor', { config: { message: 'hi' }, invalid: { message: 42 } }],
  ['workflows/nodes/action-todo-create.executor.js', 'ActionTodoCreateExecutor', { config: { title: 't' }, invalid: { title: '' } }],
  ['workflows/nodes/action-notify.executor.js', 'ActionNotifyExecutor', { config: { title: 'n' }, invalid: { title: '' } }],
  ['workflows/nodes/action-todo-update.executor.js', 'ActionTodoUpdateExecutor', { config: { todoId: 'abc' }, invalid: { todoId: '' } }],
  ['workflows/nodes/action-todo-comment.executor.js', 'ActionTodoCommentExecutor', { config: { todoId: 'a', text: 'x' }, invalid: { todoId: 'a' } }],
  ['workflows/nodes/action-todo-link-milestone.executor.js', 'ActionTodoLinkMilestoneExecutor', { config: { todoId: 'a', milestoneId: 'b' }, invalid: { todoId: '', milestoneId: 'b' } }],
  ['workflows/nodes/action-knowledge-create.executor.js', 'ActionKnowledgeCreateExecutor', { config: { topic: 't', content: 'c' }, invalid: { topic: 't' } }],
  ['workflows/nodes/action-manual-create.executor.js', 'ActionManualCreateExecutor', { config: { title: 't' }, invalid: { title: '' } }],
  ['workflows/nodes/action-changelog-add.executor.js', 'ActionChangelogAddExecutor', { config: { changes: ['a'] }, invalid: { changes: [] } }],
  ['workflows/nodes/action-user-question.executor.js', 'ActionUserQuestionExecutor', { config: { question: 'q' }, invalid: { question: '' } }],
  ['workflows/nodes/control-condition.executor.js', 'ControlConditionExecutor', {
    config: { cases: [{ when: { path: 'a', op: 'eq', value: 1 }, branch: 'success' }] },
    invalid: { cases: [{ when: { path: '', op: 'eq', value: 1 }, branch: 'success' }] },
  }],
  ['workflows/nodes/control-delay.executor.js', 'ControlDelayExecutor', {
    config: { delayMs: 1000 },
    invalid: { delayMs: 1000, until: new Date().toISOString() },
  }],
  ['workflows/nodes/trigger-project-event.executor.js', 'TriggerProjectEventExecutor', {
    config: { entity: 'todo', action: 'created' },
    invalid: { entity: 'nope', action: 'created' },
  }],
  ['workflows/nodes/trigger-customer-event.executor.js', 'TriggerCustomerEventExecutor', {
    config: { entity: 'todo', action: '*' },
    invalid: { entity: 'todo', action: 'nope' },
  }],
  ['workflows/nodes/agent-task.executor.js', 'AgentTaskExecutor', { config: { prompt: 'hi' }, invalid: { prompt: '' } }],
];

for (const [relPath, exportName, fixture] of allExecutors) {
  const Cls = loadCompiled(relPath)[exportName];
  const instance = new Cls();
  const meta = instance.metadata ?? Cls.prototype.metadata;
  check(`${exportName}.metadata.configSchema accepts valid config`, () => {
    const parsed = meta.configSchema.safeParse(fixture.config);
    if (!parsed.success) throw new Error(`expected valid but got: ${JSON.stringify(parsed.error.issues)}`);
  });
  if (fixture.invalid !== null) {
    check(`${exportName}.metadata.configSchema rejects invalid config`, () => {
      const parsed = meta.configSchema.safeParse(fixture.invalid);
      assert.equal(parsed.success, false);
    });
  }
}

// ---------- WorkflowEventListener.matches ----------
const listenerMod = loadCompiled('workflows/engine/workflow-event-listener.service.js');
const ListenerCls = listenerMod.WorkflowEventListener;
const matches = Object.create(ListenerCls.prototype).matches;

check('matches: exact entity/action', () => {
  assert.equal(matches.call({}, { entity: 'todo', action: 'created' }, { entity: 'todo', action: 'created' }), true);
});
check('matches: entity wildcard', () => {
  assert.equal(matches.call({}, { entity: '*', action: 'created' }, { entity: 'knowledge', action: 'created' }), true);
});
check('matches: action wildcard', () => {
  assert.equal(matches.call({}, { entity: 'todo', action: '*' }, { entity: 'todo', action: 'deleted' }), true);
});
check('matches: entity mismatch fails', () => {
  assert.equal(matches.call({}, { entity: 'todo', action: 'created' }, { entity: 'milestone', action: 'created' }), false);
});
check('matches: action mismatch fails', () => {
  assert.equal(matches.call({}, { entity: 'todo', action: 'updated' }, { entity: 'todo', action: 'deleted' }), false);
});

// ---------- toPublicMetadata exports ----------
check('toPublicMetadata serializes configJsonSchema', () => {
  const { toPublicMetadata } = nodeMetadata;
  const { z } = require(path.resolve(__dirname, '..', 'node_modules', 'zod'));
  const meta = {
    type: 'x',
    category: 'action',
    label: 'x',
    description: 'x',
    allowedScopes: [],
    configSchema: z.object({ a: z.string() }),
    outputs: {},
    branches: ['success'],
  };
  const pub = toPublicMetadata(meta);
  assert.equal(pub.type, 'x');
  assert.equal(typeof pub.configJsonSchema, 'object');
});

// ----------
if (failures > 0) {
  console.error(`\n${failures}/${total} checks failed`);
  process.exit(1);
}
console.log(`\nAll ${total} checks passed`);
