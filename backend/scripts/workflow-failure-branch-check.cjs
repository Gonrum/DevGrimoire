#!/usr/bin/env node
/*
 * Fehlerzweig der Workflow-Engine: hasBranchEdges und die Form des
 * Kontext-Eintrags eines gescheiterten Nodes. Nach `npm run build` ausführen.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

const walker = require(path.resolve(__dirname, '..', 'dist/workflows/engine/graph-walker.js'));
const engine = require(path.resolve(__dirname, '..', 'dist/workflows/engine/workflow-engine.service.js'));

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`ok   ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${label}: ${err.message}`);
  }
}

const g = (edges) => ({ nodes: [], edges });

check('failure-Edge wird erkannt', () => {
  assert.equal(walker.hasBranchEdges('a', 'failure', g([{ id: 'e', source: 'a', target: 'b', branch: 'failure' }])), true);
});
check('ohne failure-Edge false', () => {
  assert.equal(walker.hasBranchEdges('a', 'failure', g([{ id: 'e', source: 'a', target: 'b', branch: 'success' }])), false);
});
check('always-Edge zaehlt nicht', () => {
  assert.equal(walker.hasBranchEdges('a', 'failure', g([{ id: 'e', source: 'a', target: 'b', branch: 'always' }])), false);
  assert.equal(walker.hasBranchEdges('a', 'failure', g([{ id: 'e', source: 'a', target: 'b' }])), false);
});
check('failure-Edge eines anderen Nodes zaehlt nicht', () => {
  assert.equal(walker.hasBranchEdges('a', 'failure', g([{ id: 'e', source: 'x', target: 'b', branch: 'failure' }])), false);
});
check('contextUpdatePipeline traegt nodes.<id>.error.code', () => {
  const out = { stdout: 'x', error: { code: 'ssh_timeout', message: 'zu langsam' } };
  const stages = engine.contextUpdatePipeline('n1', out, []);
  const set = stages[1].$set['context.nodes'].$setField;
  assert.equal(set.field.$literal, 'n1');
  assert.equal(set.value.$literal.error.code, 'ssh_timeout');
  assert.equal(set.value.$literal.stdout, 'x');
});
check('failureContextEntry: Defaults ohne Fehler/Output', () => {
  assert.deepEqual(engine.failureContextEntry({ status: 'failed' }), { error: { code: 'failed', message: 'node failed' } });
});
check('failureContextEntry: Output bleibt, Fehler wird uebernommen', () => {
  const e = engine.failureContextEntry({ status: 'failed', output: { stdout: 'x' }, error: { code: 'c', message: 'm' } });
  assert.deepEqual(e, { stdout: 'x', error: { code: 'c', message: 'm' } });
});

const n = (id) => ({ id, type: 'action.log', config: {} });
check('failureSuccessors: nur ausdruecklich beschriftete failure-Edges (Final-Review I1)', () => {
  // ssh step1 → step2 (unbeschriftet) + step1 -failure-> alarm: step2 darf nach
  // einem Fehlschlag von step1 NICHT laufen.
  const graph = {
    nodes: [n('step1'), n('step2'), n('alarm'), n('ok'), n('always')],
    edges: [
      { id: 'e1', source: 'step1', target: 'step2' },
      { id: 'e2', source: 'step1', target: 'alarm', branch: 'failure' },
      { id: 'e3', source: 'step1', target: 'ok', branch: 'success' },
      { id: 'e4', source: 'step1', target: 'always', branch: 'always' },
      { id: 'e5', source: 'step1', target: 'alarm', branch: 'failure' },
    ],
  };
  assert.deepEqual(walker.failureSuccessors('step1', graph).map((x) => x.id), ['alarm']);
  // Zum Vergleich: nextNodes nimmt always-Edges mit — deshalb nicht auf dem Fehlerpfad.
  assert.deepEqual(walker.nextNodes('step1', 'failure', graph).map((x) => x.id).sort(), ['alarm', 'always', 'step2']);
});
check('failureSuccessors: unbekanntes Ziel wird uebersprungen', () => {
  const graph = { nodes: [n('a')], edges: [{ id: 'e', source: 'a', target: 'weg', branch: 'failure' }] };
  assert.deepEqual(walker.failureSuccessors('a', graph), []);
});

if (failures) {
  console.error(`${failures} failed`);
  process.exit(1);
}
