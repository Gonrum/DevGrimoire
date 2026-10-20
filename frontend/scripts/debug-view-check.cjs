#!/usr/bin/env node
/**
 * Debug-Modus im Editor: Node-Zustände für das Canvas, Schrittfreigabe,
 * Eingabe-JSON und Prüfungsfehler-Zeilen.
 * Übersetzt die importfreie `src/lib/debug-view.ts` nach CommonJS
 * (Muster: placeholder-view-check.cjs).
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-debug-view-'));
try {
  execFileSync('npx', ['tsc', 'src/lib/debug-view.ts', '--outDir', outDir, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck'],
    { cwd: root, stdio: 'pipe' });
} catch (err) {
  console.error('tsc-Übersetzung fehlgeschlagen:');
  console.error(err.stdout ? err.stdout.toString() : err.message);
  process.exit(1);
}
const { nodeDebugStates, canStep, latestNodeRun, isTerminalRunStatus, parseDebugInput, issueLines } =
  require(path.join(outDir, 'debug-view.js'));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`✓ ${label}`); } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
  }
}

check('nodeDebugStates: höchster attempt gewinnt, ohne NodeRun idle, current = erster pending', () => {
  const states = nodeDebugStates(
    ['t', 'a', 'b'],
    [
      { nodeId: 't', status: 'succeeded', attempt: 1 },
      { nodeId: 'a', status: 'failed', attempt: 1 },
      { nodeId: 'a', status: 'succeeded', attempt: 2, dryRun: true },
    ],
    ['b'],
  );
  assert.deepEqual(states.t, { status: 'succeeded', dry: false, current: false });
  assert.deepEqual(states.a, { status: 'succeeded', dry: true, current: false });
  assert.deepEqual(states.b, { status: 'idle', dry: false, current: true });
});
check('nodeDebugStates: Reihenfolge der NodeRuns egal, nur erster pending ist current', () => {
  const states = nodeDebugStates(
    ['a', 'b', 'c'],
    [
      { nodeId: 'a', status: 'succeeded', attempt: 2 },
      { nodeId: 'a', status: 'failed', attempt: 1, dryRun: true },
    ],
    ['c', 'b'],
  );
  assert.deepEqual(states.a, { status: 'succeeded', dry: false, current: false });
  assert.equal(states.b.current, false);
  assert.equal(states.c.current, true);
});
check('nodeDebugStates: NodeRuns entfernter Nodes erscheinen nicht', () => {
  const states = nodeDebugStates(['a'], [{ nodeId: 'gone', status: 'failed', attempt: 1 }], []);
  assert.deepEqual(Object.keys(states), ['a']);
});

check('canStep nur bei waiting_for_step', () => {
  assert.equal(canStep('waiting_for_step'), true);
  assert.equal(canStep('running'), false);
  assert.equal(canStep('waiting_for_user'), false);
  assert.equal(canStep('succeeded'), false);
  assert.equal(canStep(undefined), false);
});

check('latestNodeRun: höchster attempt des Nodes, sonst undefined', () => {
  const runs = [
    { nodeId: 'a', status: 'failed', attempt: 1 },
    { nodeId: 'a', status: 'succeeded', attempt: 3 },
    { nodeId: 'a', status: 'failed', attempt: 2 },
    { nodeId: 'b', status: 'succeeded', attempt: 9 },
  ];
  assert.equal(latestNodeRun(runs, 'a').attempt, 3);
  assert.equal(latestNodeRun(runs, 'x'), undefined);
  assert.equal(latestNodeRun(runs, null), undefined);
});

check('isTerminalRunStatus', () => {
  for (const s of ['succeeded', 'failed', 'cancelled']) assert.equal(isTerminalRunStatus(s), true);
  for (const s of ['queued', 'running', 'waiting_for_step', 'waiting_for_user', 'waiting_for_timer', undefined]) {
    assert.equal(isTerminalRunStatus(s), false);
  }
});

check('parseDebugInput: leer → {}, Objekt → Objekt, sonst null', () => {
  assert.deepEqual(parseDebugInput(''), {});
  assert.deepEqual(parseDebugInput('   '), {});
  assert.deepEqual(parseDebugInput('{}'), {});
  assert.deepEqual(parseDebugInput('{"a":1}'), { a: 1 });
  assert.equal(parseDebugInput('{a:1}'), null);
  assert.equal(parseDebugInput('[1]'), null);
  assert.equal(parseDebugInput('null'), null);
  assert.equal(parseDebugInput('3'), null);
});

check('issueLines: Prüfungsfehler als Liste', () => {
  assert.deepEqual(issueLines('a; b;  c'), ['a', 'b', 'c']);
  assert.deepEqual(issueLines('nur eins'), ['nur eins']);
  assert.deepEqual(issueLines(''), []);
});

fs.rmSync(outDir, { recursive: true, force: true });
if (failures) {
  console.error(`${failures} failed`);
  process.exit(1);
}
console.log('debug-view-check: OK');
