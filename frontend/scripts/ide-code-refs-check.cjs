#!/usr/bin/env node
/**
 * Pure logic for code attachments in the IDE agent chat. Compiles the
 * import-free `src/ide/code-refs.ts` to CommonJS (pattern: research-lib-check.cjs).
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-code-refs-'));
try {
  execFileSync('npx', ['tsc', 'src/ide/code-refs.ts', '--outDir', outDir, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck'],
    { cwd: root, stdio: 'pipe' });
} catch (err) {
  console.error('tsc compilation failed:');
  console.error(err.stdout ? err.stdout.toString() : err.message);
  process.exit(1);
}
const r = require(path.join(outDir, 'code-refs.js'));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`✓ ${label}`); } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
  }
}
const sel = (startLineNumber, startColumn, endLineNumber, endColumn) => ({ startLineNumber, startColumn, endLineNumber, endColumn });
const s = (path, startLine, endLine, text = 'x') => ({ kind: 'selection', path, startLine, endLine, text });

check('constants', () => {
  assert.equal(r.MAX_CODE_REFS, 10);
  assert.equal(r.MAX_CODE_REF_TEXT, 20000);
});

check('selectionLines', () => {
  assert.deepEqual(r.selectionLines(sel(3, 5, 7, 1)), { startLine: 3, endLine: 6 });
  assert.deepEqual(r.selectionLines(sel(3, 5, 7, 4)), { startLine: 3, endLine: 7 });
  assert.deepEqual(r.selectionLines(sel(4, 1, 4, 9)), { startLine: 4, endLine: 4 });
  assert.deepEqual(r.selectionLines(sel(4, 1, 5, 1)), { startLine: 4, endLine: 4 });
});

check('addCodeRef results', () => {
  const a = r.addCodeRef([], s('a.ts', 1, 2));
  assert.equal(a.result, 'added');
  assert.equal(a.list.length, 1);
  const dup = r.addCodeRef(a.list, s('a.ts', 1, 2, 'other'));
  assert.equal(dup.result, 'duplicate');
  assert.deepEqual(dup.list, a.list);
  assert.equal(r.addCodeRef(a.list, s('a.ts', 3, 4)).result, 'added');
  assert.equal(r.addCodeRef([], s('a.ts', 1, 2, 'y'.repeat(20001))).result, 'too-large');
  assert.equal(r.addCodeRef([], s('a.ts', 1, 2, 'y'.repeat(20000))).result, 'added');
  const ten = Array.from({ length: 10 }, (_, i) => s('f.ts', i + 1, i + 1));
  const full = r.addCodeRef(ten, s('g.ts', 1, 1));
  assert.equal(full.result, 'full');
  assert.equal(full.list.length, 10);
});

check('file and selection in same path are not duplicates; file duplicates', () => {
  const f = { kind: 'file', path: 'a.ts' };
  const l = r.addCodeRef([f], s('a.ts', 1, 1));
  assert.equal(l.result, 'added');
  assert.equal(r.addCodeRef([f], { kind: 'file', path: 'a.ts' }).result, 'duplicate');
});

check('addCodeRef does not mutate input', () => {
  const input = [s('a.ts', 1, 1)];
  r.addCodeRef(input, s('b.ts', 1, 1));
  assert.equal(input.length, 1);
});

check('codeRefLabel', () => {
  assert.equal(r.codeRefLabel(s('src/a.ts', 12, 20)), 'src/a.ts:12–20');
  assert.equal(r.codeRefLabel(s('src/a.ts', 12, 12)), 'src/a.ts:12');
  assert.equal(r.codeRefLabel({ kind: 'file', path: 'src/a.ts' }), 'src/a.ts');
});

check('invalid paths rejected', () => {
  const bad = ['/etc/x', 'a/../b', './a', 'a//b', 'a\\b', '', 'a'.repeat(1025), 'a\0b', 'a`b', 'a\nb', 'a\x7fb', 'a\u2028b', 'a\u202eb', 'a\u0085b', 'a/.'];
  for (const p of bad) {
    assert.equal(r.addCodeRef([], { kind: 'file', path: p }).result, 'invalid', JSON.stringify(p));
    assert.equal(r.addCodeRef([], s(p, 1, 1)).result, 'invalid', JSON.stringify(p));
  }
  assert.equal(r.addCodeRef([], { kind: 'file', path: 'docs/Über uns.md' }).result, 'added');
  assert.equal(r.addCodeRef([], { kind: 'file', path: 'a'.repeat(1024) }).result, 'added');
});

fs.rmSync(outDir, { recursive: true, force: true });
if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log('all ok');
