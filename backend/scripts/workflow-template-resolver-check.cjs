#!/usr/bin/env node
/**
 * Zentraler Platzhalter-Resolver (`template-resolver.ts`) und seine Regeln in
 * `template.ts` — läuft gegen `dist/`, ohne Nest und ohne MongoDB.
 */
const assert = require('node:assert/strict');
const {
  SECRET_MASK,
  resolveConfig,
  lookupOwnPath,
  findSecretKeys,
  maskSecrets,
  TemplateUnresolvedError,
} = require('../dist/workflows/nodes/template-resolver');
const { expandTemplate, lookupPath } = require('../dist/workflows/nodes/template');

const ctx = {
  input: {},
  nodes: {
    a: { n: 3, o: { x: 1 }, items: [{ id: 'i1' }], nul: null, empty: '' },
    dry: { dryRun: true, stdout: null },
  },
};
const open = { secretsAllowed: false };

assert.equal(SECRET_MASK, '••••');

// Werte
assert.equal(resolveConfig({ t: '{{nodes.a.n}}' }, ctx, open).value.t, '3');
assert.equal(resolveConfig({ t: '{{nodes.a.o}}' }, ctx, open).value.t, '{"x":1}');
assert.equal(resolveConfig({ t: '{{nodes.a.items.0.id}}' }, ctx, open).value.t, 'i1');
assert.equal(resolveConfig({ t: '{{context.nodes.a.n}}' }, ctx, open).value.t, '3');
assert.equal(resolveConfig({ t: '{{{nodes.a.n}}}' }, ctx, open).placeholders[0].raw, true);
assert.equal(resolveConfig({ t: 5, u: true }, ctx, open).value.t, 5);

// null / leer
for (const p of ['nodes.a.nul', 'nodes.a.empty']) {
  const r = resolveConfig({ t: `x{{${p}}}y` }, ctx, open);
  assert.equal(r.value.t, 'xy');
  assert.equal(r.ok, true);
  assert.equal(r.placeholders[0].status, 'empty');
}

// fehlend
{
  const r = resolveConfig({ t: 'v={{nodes.a.nope}}' }, ctx, open);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['nodes.a.nope']);
  assert.ok(r.value.t.includes('{{nodes.a.nope}}'));
  assert.equal(r.placeholders[0].status, 'missing');
}
for (const p of ['nodes.a.constructor', 'nodes.a.__proto__']) {
  const r = resolveConfig({ t: `{{${p}}}` }, ctx, open);
  assert.deepEqual(r.missing, [p]);
}
{
  const r = resolveConfig({ t: '{{x.y}} {{x.y}}', u: '{{x.z}}' }, ctx, open);
  assert.deepEqual(r.missing, ['x.y', 'x.z']);
}

// Escape
{
  const r = resolveConfig({ t: '\\{{nodes.a.n}}', u: '\\{{{nodes.a.n}}}' }, ctx, open);
  assert.equal(r.value.t, '{{nodes.a.n}}');
  assert.equal(r.value.u, '{{{nodes.a.n}}}');
  assert.equal(r.placeholders.length, 0);
  assert.equal(r.ok, true);
}

// Trockenlauf-Unbekannt
for (const p of ['nodes.dry.stdout', 'nodes.dry.other']) {
  const r = resolveConfig({ t: `[{{${p}}}]` }, ctx, open);
  assert.equal(r.ok, true);
  assert.equal(r.placeholders[0].status, 'unknown');
  assert.equal(r.value.t, '[]');
}
assert.deepEqual(lookupOwnPath('nodes.dry.other', ctx), { found: true, value: undefined, unknown: true });
assert.equal(lookupOwnPath('nodes.a.nope', ctx).found, false);
assert.equal(lookupOwnPath('context.nodes.a.n', ctx).value, 3);

// Zeile / Feld
assert.equal(resolveConfig({ t: 'a\n{{nodes.a.nope}}' }, ctx, open).placeholders[0].line, 2);
assert.equal(resolveConfig({ retry: { x: '{{nodes.a.n}}' } }, ctx, open).placeholders[0].field, 'retry.x');
assert.equal(resolveConfig({ tags: ['{{nodes.a.n}}'] }, ctx, open).placeholders[0].field, 'tags.0');

// Secrets
{
  const cfg = { c: 'x {{secrets.T}}' };
  const r = resolveConfig(cfg, ctx, { secrets: { T: 'geheim123' }, secretsAllowed: true });
  assert.equal(r.value.c, 'x geheim123');
  assert.equal(r.display.c, 'x ••••(T)');
  assert.equal(r.placeholders[0].status, 'secret');
  assert.ok(!String(r.placeholders[0].preview).includes('geheim123'));
  assert.equal(r.ok, true);

  const f = resolveConfig(cfg, ctx, { secrets: { T: 'geheim123' }, secretsAllowed: false });
  assert.equal(f.ok, false);
  assert.deepEqual(f.forbiddenSecrets, ['T']);
  assert.ok(!JSON.stringify(f).includes('geheim123'));

  const m = resolveConfig(cfg, ctx, { secrets: {}, secretsAllowed: true });
  assert.equal(m.ok, false);
  assert.deepEqual(m.missing, ['secrets.T']);
  const p = resolveConfig(cfg, ctx, { secrets: {}, secretsAllowed: true });
  assert.equal(p.placeholders[0].status, 'missing');
  // Prototyp-Schlüssel sind kein Secret
  const c = resolveConfig({ c: '{{secrets.constructor}}' }, ctx, { secrets: {}, secretsAllowed: true });
  assert.deepEqual(c.missing, ['secrets.constructor']);
}

assert.deepEqual(findSecretKeys({ a: '{{secrets.A}} {{{secrets.B}}}', b: ['{{secrets.A}}'] }), ['A', 'B']);
assert.deepEqual(findSecretKeys({ a: '\\{{secrets.A}}' }), []);

assert.deepEqual(maskSecrets({ o: 'x geheim123 y', n: ['geheim123'], k: 5 }, ['geheim123', 'ab']), {
  o: 'x •••• y',
  n: ['••••'],
  k: 5,
});
assert.equal(maskSecrets('abcd abcdef', ['abcd', 'abcdef']), '•••• ••••');
assert.equal(maskSecrets('ab', ['ab']), 'ab');

{
  const e = new TemplateUnresolvedError(['a.b']);
  assert.ok(e instanceof Error);
  assert.deepEqual(e.missing, ['a.b']);
}

// template.ts übernimmt die Regeln
assert.equal(expandTemplate('{{nodes.a.nul}}', ctx), '');
assert.equal(expandTemplate('\\{{x}}', ctx), '{{x}}');
assert.equal(expandTemplate('{{nodes.a.constructor}}', ctx), '{{nodes.a.constructor}}');
assert.equal(expandTemplate('{{nodes.a.n}}', ctx), '3');
assert.equal(lookupPath('nodes.a.n', ctx), 3);
assert.equal(lookupPath('nodes.a.constructor', ctx), undefined);

console.log('workflow-template-resolver-check: OK');
