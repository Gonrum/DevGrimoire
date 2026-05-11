#!/usr/bin/env node
/*
 * Pure-logic regression check for the workflow runner (T-250).
 * Loads compiled helpers from dist/ and exercises them.
 * Run with `npm run check:workflow-runner-units` from backend/ after a build.
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

const { NodeRegistry } = loadCompiled('workflows/engine/node-registry.js');
const graphWalker = loadCompiled('workflows/engine/graph-walker.js');
const scheduler = loadCompiled('workflows/engine/scheduler-helpers.js');
const tmpl = loadCompiled('workflows/nodes/template.js');

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

// ---------- NodeRegistry ----------
check('NodeRegistry registers and retrieves executor', () => {
  const reg = new NodeRegistry();
  const exec = { type: 'x.test', execute: async () => ({ status: 'success' }) };
  reg.register(exec);
  assert.equal(reg.get('x.test'), exec);
  assert.equal(reg.has('x.test'), true);
});

check('NodeRegistry.get on unknown type throws', () => {
  const reg = new NodeRegistry();
  assert.throws(() => reg.get('does.not.exist'));
});

check('NodeRegistry.list returns sorted types', () => {
  const reg = new NodeRegistry();
  reg.register({ type: 'b', execute: async () => ({ status: 'success' }) });
  reg.register({ type: 'a', execute: async () => ({ status: 'success' }) });
  assert.deepEqual(reg.list(), ['a', 'b']);
});

// ---------- graph-walker ----------
const sampleGraph = {
  nodes: [
    { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
    { id: 'a', type: 'action.log', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
    { id: 'b', type: 'action.log', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
    { id: 'c', type: 'action.log', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
  ],
  edges: [
    { id: 'e1', source: 't', target: 'a' },
    { id: 'e2', source: 'a', target: 'b', branch: 'success' },
    { id: 'e3', source: 'a', target: 'c', branch: 'failure' },
  ],
};

check('findTriggerNodes returns trigger nodes only', () => {
  const triggers = graphWalker.findTriggerNodes(sampleGraph);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].id, 't');
});

check('nextNodes filters by branch', () => {
  const succ = graphWalker.nextNodes('a', 'success', sampleGraph);
  assert.deepEqual(succ.map((n) => n.id), ['b']);
  const fail = graphWalker.nextNodes('a', 'failure', sampleGraph);
  assert.deepEqual(fail.map((n) => n.id), ['c']);
});

check('nextNodes treats edge without branch as always', () => {
  const after = graphWalker.nextNodes('t', 'success', sampleGraph);
  assert.deepEqual(after.map((n) => n.id), ['a']);
});

check('nextNodes dedupes when multiple edges converge', () => {
  const graph = {
    nodes: [
      { id: 'a', type: 'x', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
      { id: 'b', type: 'x', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'b', branch: 'success' },
      { id: 'e2', source: 'a', target: 'b', branch: 'always' },
    ],
  };
  const after = graphWalker.nextNodes('a', 'success', graph);
  assert.equal(after.length, 1);
});

// ---------- scheduler-helpers ----------
check('computeNext (interval)', () => {
  const base = new Date('2026-05-11T12:00:00.000Z');
  const next = scheduler.computeNext({ type: 'schedule', intervalMinutes: 5 }, base);
  assert.equal(next.toISOString(), '2026-05-11T12:05:00.000Z');
});

check('computeNext (cron)', () => {
  const base = new Date('2026-05-11T12:00:00.000Z');
  const next = scheduler.computeNext({ type: 'schedule', cron: '*/15 * * * *' }, base);
  assert.equal(next.toISOString(), '2026-05-11T12:15:00.000Z');
});

check('computeNext throws when neither cron nor interval', () => {
  assert.throws(() => scheduler.computeNext({ type: 'schedule' }, new Date()));
});

check('computeMissedSlots respects maxCatchUp', () => {
  const last = new Date('2026-05-11T12:00:00.000Z');
  const now = new Date('2026-05-11T12:30:00.000Z');
  const slots = scheduler.computeMissedSlots(
    last,
    now,
    { type: 'schedule', intervalMinutes: 5, maxCatchUp: 2 },
  );
  assert.equal(slots.length, 2);
  assert.equal(slots[0].toISOString(), '2026-05-11T12:05:00.000Z');
  assert.equal(slots[1].toISOString(), '2026-05-11T12:10:00.000Z');
});

check('computeMissedSlots returns [] if nothing missed', () => {
  const last = new Date('2026-05-11T12:00:00.000Z');
  const now = new Date('2026-05-11T12:03:00.000Z');
  const slots = scheduler.computeMissedSlots(last, now, {
    type: 'schedule',
    intervalMinutes: 5,
  });
  assert.deepEqual(slots, []);
});

check('computeMissedSlots first-ever run does not backfill but fires when due', () => {
  const now = new Date('2026-05-11T12:00:00.000Z');
  const slots = scheduler.computeMissedSlots(undefined, now, {
    type: 'schedule',
    cron: '0 12 * * *',
  });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].toISOString(), '2026-05-11T12:00:00.000Z');
});

// ---------- template ----------
check('expandTemplate replaces simple paths', () => {
  const out = tmpl.expandTemplate('hi {{name}}', { name: 'Anna' });
  assert.equal(out, 'hi Anna');
});

check('expandTemplate replaces nested paths with context prefix', () => {
  const out = tmpl.expandTemplate('id={{context.nodes.x.id}}', {
    nodes: { x: { id: 'abc' } },
  });
  assert.equal(out, 'id=abc');
});

check('expandTemplate leaves unknown paths literal', () => {
  const out = tmpl.expandTemplate('val={{missing.thing}}', {});
  assert.equal(out, 'val={{missing.thing}}');
});

check('expandConfig recurses into objects and arrays', () => {
  const out = tmpl.expandConfig(
    { title: 'T {{x}}', meta: { sub: '{{x}}', list: ['{{x}}', 'static'] } },
    { x: '42' },
  );
  assert.equal(out.title, 'T 42');
  assert.equal(out.meta.sub, '42');
  assert.deepEqual(out.meta.list, ['42', 'static']);
});

// ----------
if (failures > 0) {
  console.error(`\n${failures}/${total} checks failed`);
  process.exit(1);
}
console.log(`\nAll ${total} checks passed`);
