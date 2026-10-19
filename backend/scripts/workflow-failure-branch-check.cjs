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

if (failures) {
  console.error(`${failures} failed`);
  process.exit(1);
}
