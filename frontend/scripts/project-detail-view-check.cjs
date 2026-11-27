#!/usr/bin/env node
/**
 * Project detail page: sidebar "more" split and overview open-todo selection.
 * Compiles the import-free `src/lib/project-detail-view.ts` to CommonJS
 * (pattern: placeholder-view-check.cjs) and asserts its decisions.
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-project-detail-view-'));
try {
  execFileSync('npx', ['tsc', 'src/lib/project-detail-view.ts', '--outDir', outDir, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck'],
    { cwd: root, stdio: 'pipe' });
} catch (err) {
  console.error('tsc compilation failed:');
  console.error(err.stdout ? err.stdout.toString() : err.message);
  process.exit(1);
}
const { MORE_TABS, splitMore, moreOpen, showCount, pickOpenTodos } = require(path.join(outDir, 'project-detail-view.js'));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`✓ ${label}`); } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
  }
}

check('MORE_TABS holds exactly the agreed keys', () => {
  assert.deepEqual([...MORE_TABS].sort(), ['access', 'commits', 'http-requests', 'kube', 'logs', 'recurring-tasks', 'ssh', 'workflows']);
});

check('splitMore keeps order and separates more-tabs', () => {
  const r = splitMore([{ key: 'soul' }, { key: 'logs' }, { key: 'workspaces' }, { key: 'ssh' }]);
  assert.deepEqual(r.main.map((i) => i.key), ['soul', 'workspaces']);
  assert.deepEqual(r.more.map((i) => i.key), ['logs', 'ssh']);
});

check('moreOpen: stored, active inside, or searching', () => {
  assert.equal(moreOpen(false, 'logs', false), true);
  assert.equal(moreOpen(false, 'soul', false), false);
  assert.equal(moreOpen(false, 'soul', true), true);
  assert.equal(moreOpen(true, 'soul', false), true);
});

check('showCount only for positive numbers', () => {
  assert.equal(showCount(0), false);
  assert.equal(showCount(undefined), false);
  assert.equal(showCount(3), true);
});

const todo = (n, status, priority, updatedAt, archived = false) => ({ n, status, priority, updatedAt, archived });

check('pickOpenTodos limits and counts the rest', () => {
  const todos = [];
  for (let i = 0; i < 10; i += 1) todos.push(todo(i, 'open', 'medium', `2026-01-${String(i + 1).padStart(2, '0')}`));
  todos.push(todo(98, 'done', 'critical', '2026-02-01'));
  todos.push(todo(99, 'done', 'critical', '2026-02-01'));
  const r = pickOpenTodos(todos, 8);
  assert.equal(r.shown.length, 8);
  assert.equal(r.rest, 2);
});

check('pickOpenTodos excludes done and archived', () => {
  const r = pickOpenTodos([
    todo(1, 'done', 'high', '2026-01-01'),
    todo(2, 'open', 'high', '2026-01-01', true),
    todo(3, 'review', 'low', '2026-01-01'),
  ], 8);
  assert.deepEqual(r.shown.map((t) => t.n), [3]);
  assert.equal(r.rest, 0);
});

check('pickOpenTodos sorts by priority, then newest first', () => {
  const r = pickOpenTodos([
    todo(1, 'open', 'low', '2026-03-01'),
    todo(2, 'open', 'critical', '2026-01-01'),
    todo(3, 'in_progress', 'high', '2026-01-01'),
    todo(4, 'open', 'high', '2026-02-01'),
  ], 8);
  assert.deepEqual(r.shown.map((t) => t.n), [2, 4, 3, 1]);
});

fs.rmSync(outDir, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nproject-detail-view: all checks passed');
