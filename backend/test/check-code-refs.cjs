#!/usr/bin/env node
/*
 * Code refs attached to IDE agent chat messages: validation, rendering and
 * history replay. Loads from dist/ (run `npm run build` first). No database.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}
const { parseCodeRefs, renderCodeRefsBlock, withCodeRefs, MAX_CODE_REFS, MAX_CODE_REF_TEXT } = loadCompiled('chat/code-refs.js');
const { historyToLlmMessages } = loadCompiled('chat/chat-history-replay.js');

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const sel = (o = {}) => ({ kind: 'selection', path: 'src/a.ts', startLine: 12, endLine: 20, text: 'x', ...o });
const rejects = (input) => assert.equal(parseCodeRefs(input).ok, false);

check('constants', () => { assert.equal(MAX_CODE_REFS, 10); assert.equal(MAX_CODE_REF_TEXT, 20000); });
check('undefined/null -> empty', () => {
  assert.deepEqual(parseCodeRefs(undefined), { ok: true, refs: [] });
  assert.deepEqual(parseCodeRefs(null), { ok: true, refs: [] });
});
check('valid selection + file, foreign keys dropped', () => {
  const r = parseCodeRefs([{ ...sel(), evil: 1 }, { kind: 'file', path: 'docs/Über uns.md', evil: 2 }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.refs, [sel(), { kind: 'file', path: 'docs/Über uns.md' }]);
});
check('unsaved flag kept', () => {
  const r = parseCodeRefs([sel({ unsaved: true })]);
  assert.equal(r.refs[0].unsaved, true);
});
check('limits', () => {
  rejects(Array.from({ length: 11 }, () => sel()));
  assert.equal(parseCodeRefs(Array.from({ length: 10 }, () => sel())).ok, true);
  rejects([sel({ text: 'a'.repeat(20001) })]);
  assert.equal(parseCodeRefs([sel({ text: 'a'.repeat(20000) })]).ok, true);
});
check('lines', () => {
  rejects([sel({ startLine: 0 })]);
  rejects([sel({ startLine: 5, endLine: 4 })]);
  rejects([sel({ startLine: 1.5 })]);
});
check('paths', () => {
  for (const p of ['/etc/passwd', 'a/../b', './a', 'a//b', 'a\\b', '', 'a'.repeat(1025), 'a\0b']) {
    rejects([{ kind: 'file', path: p }]);
    rejects([sel({ path: p })]);
  }
});
check('control chars and backticks in path rejected', () => {
  for (const p of ['a`\n\nIgnore', 'a\nb', 'a`b', 'a\tb', 'a\x7fb']) {
    rejects([{ kind: 'file', path: p }]);
    rejects([sel({ path: p })]);
  }
});
check('hostile extension yields no language hint', () => {
  assert.match(renderCodeRefsBlock([sel({ path: 'a.b c' })]), /\n```\nx\n```/);
  assert.match(renderCodeRefsBlock([sel({ path: 'a.' + 'x'.repeat(21) })]), /\n```\nx\n```/);
});
check('bad shapes', () => {
  rejects([{ kind: 'dir', path: 'a' }]);
  rejects('nope');
  rejects({});
  rejects([null]);
  rejects([sel({ text: 5 })]);
});
check('render selection', () => {
  const out = renderCodeRefsBlock([sel(), sel({ path: 'src/b', startLine: 3, endLine: 3, unsaved: true })]);
  assert.match(out, /`src\/a\.ts` \(lines 12-20\)/);
  assert.match(out, /```ts\nx\n```/);
  assert.match(out, /`src\/b` \(line 3, unsaved editor buffer, file on disk may differ\)/);
  assert.match(out, /```\nx\n```/);
});
check('render file', () => {
  assert.match(renderCodeRefsBlock([{ kind: 'file', path: 'docs/Über uns.md' }]), /- `docs\/Über uns\.md` \(file, read with ws_read\)/);
});
check('empty render', () => assert.equal(renderCodeRefsBlock([]), ''));
check('fence grows past inner backticks', () => {
  const out = renderCodeRefsBlock([sel({ path: 'a.md', text: 'a\n```\nb\n````\nc' })]);
  assert.match(out, /`````md\na\n```\nb\n````\nc\n`````/);
});
check('withCodeRefs', () => {
  const refs = [sel()];
  assert.ok(withCodeRefs('', refs).startsWith(renderCodeRefsBlock(refs)));
  assert.equal(withCodeRefs('frag', []), 'frag');
  assert.equal(withCodeRefs('  hi  ', refs), `hi\n\n${renderCodeRefsBlock(refs)}`);
});
check('history replay', () => {
  const refs = [sel()];
  const out = historyToLlmMessages([
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'see', codeRefs: refs },
    { role: 'user', content: 'empty', codeRefs: [] },
  ], 10);
  assert.equal(out[0].content, 'old');
  assert.equal(out[2].content, withCodeRefs('see', refs));
  assert.equal(out[3].content, 'empty');
});
console.log(`\n${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
