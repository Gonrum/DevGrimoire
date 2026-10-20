#!/usr/bin/env node
/**
 * Platzhalter-Ansicht im Lauf-Inspektor / Debug-Panel.
 * Übersetzt die importfreie `src/lib/placeholder-view.ts` nach CommonJS
 * (Muster: workflow-reactivation-check.cjs) und prüft Ton je Status und Gruppierung.
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-placeholder-view-'));
try {
  execFileSync('npx', ['tsc', 'src/lib/placeholder-view.ts', '--outDir', outDir, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck'],
    { cwd: root, stdio: 'pipe' });
} catch (err) {
  console.error('tsc-Übersetzung fehlgeschlagen:');
  console.error(err.stdout ? err.stdout.toString() : err.message);
  process.exit(1);
}
const { placeholderTone, groupByField, readLines, isTruncatedSnapshot, secretPlaceholderIssue } = require(path.join(outDir, 'placeholder-view.js'));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`✓ ${label}`); } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
  }
}

check('Ton je Status', () => {
  assert.equal(placeholderTone('resolved'), 'ok');
  assert.equal(placeholderTone('secret'), 'ok');
  assert.equal(placeholderTone('empty'), 'muted');
  assert.equal(placeholderTone('unknown'), 'muted');
  assert.equal(placeholderTone('missing'), 'error');
  assert.equal(placeholderTone('secret_forbidden'), 'error');
});

const t = (field, line) => ({ field, line, expr: 'x', raw: false, status: 'resolved' });
check('groupByField: command, title, command → [command(2), title(1)]', () => {
  const groups = groupByField([t('command', 1), t('title', 1), t('command', 2)]);
  assert.deepEqual(groups.map((g) => [g.field, g.traces.length]), [['command', 2], ['title', 1]]);
  assert.deepEqual(groups[0].traces.map((x) => x.line), [1, 2]);
});
check('groupByField: leer → leer', () => {
  assert.deepEqual(groupByField([]), []);
});

check('readLines: Array → Zeilen, sonst null', () => {
  const l = { line: 1, command: 'ls', exitCode: 0, stdout: 'a', stderr: '', durationMs: 5 };
  assert.deepEqual(readLines({ lines: [l] }), [l]);
  assert.equal(readLines({ lines: 'x' }), null);
  assert.equal(readLines({ lines: [{ foo: 1 }] }), null);
  assert.equal(readLines(undefined), null);
  assert.equal(readLines({}), null);
});
check('isTruncatedSnapshot', () => {
  assert.equal(isTruncatedSnapshot({ truncated: true, preview: '{' }), true);
  assert.equal(isTruncatedSnapshot({ truncated: true }), false);
  assert.equal(isTruncatedSnapshot(null), false);
});

check('secretPlaceholderIssue: Node ohne Freigabe → KEYs', () => {
  assert.deepEqual(secretPlaceholderIssue('action.notify', false, { body: '{{secrets.T}}' }), ['T']);
  assert.deepEqual(secretPlaceholderIssue('action.notify', false, { a: ['x {{ secrets.A }}', { b: '{{secrets.B}} {{secrets.A}}' }] }), ['A', 'B']);
  assert.deepEqual(secretPlaceholderIssue('action.notify', false, { body: '{{nodes.x.y}}' }), []);
});
check('secretPlaceholderIssue: erlaubt → leer', () => {
  assert.deepEqual(secretPlaceholderIssue('ssh.exec', true, { command: '{{secrets.T}}' }), []);
});

fs.rmSync(outDir, { recursive: true, force: true });
if (failures) {
  console.error(`${failures} failed`);
  process.exit(1);
}
console.log('placeholder-view-check: OK');
