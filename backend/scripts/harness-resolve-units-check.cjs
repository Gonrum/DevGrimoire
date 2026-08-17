#!/usr/bin/env node
/*
 * Unit checks for the Harness merge resolver (T-437, M-51 / H1).
 *
 * `resolveHarness()` must stay a PURE function — no mongoose, no @nestjs
 * imports — so it is testable straight out of dist/ without booting Nest or
 * touching MongoDB. This script asserts both that purity (against the .ts
 * source) and the full merge matrix.
 *
 * Loads compiled output from dist/. Run via
 * `npm run check:harness-resolve` from backend/ after a build.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { resolveHarness } = require('../dist/harness/harness-resolve');

// --- helpers ---------------------------------------------------------------

const section = (key, body, over = {}) => ({
  key,
  kind: 'prose',
  title: key,
  body,
  mergeStrategy: 'replace',
  order: 0,
  enabled: true,
  ...over,
});

const level = (scope, sections, over = {}) => ({ scope, sections, ...over });
const byKey = (res, key) => res.sections.find((s) => s.key === key);

// --- purity: no persistence/framework imports in the resolver -------------

const resolverSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'harness', 'harness-resolve.ts'),
  'utf8',
);
assert.ok(
  !/from\s+'mongoose'/.test(resolverSrc),
  'harness-resolve.ts must not import mongoose',
);
assert.ok(
  !/from\s+'@nestjs\//.test(resolverSrc),
  'harness-resolve.ts must not import @nestjs/*',
);

// --- mergeStrategy: replace ----------------------------------------------

{
  const res = resolveHarness([
    level('global', [section('conventions', 'global body')]),
    level('project', [section('conventions', 'project body', { mergeStrategy: 'replace' })]),
  ]);
  assert.strictEqual(byKey(res, 'conventions').body, 'project body', 'replace must overwrite');
}

// --- mergeStrategy: append ------------------------------------------------

{
  const res = resolveHarness([
    level('global', [section('conventions', 'global body')]),
    level('project', [section('conventions', 'project body', { mergeStrategy: 'append' })]),
  ]);
  assert.strictEqual(
    byKey(res, 'conventions').body,
    'global body\n\nproject body',
    'append must add after the accumulated body',
  );
}

// --- mergeStrategy: prepend -----------------------------------------------

{
  const res = resolveHarness([
    level('global', [section('conventions', 'global body')]),
    level('project', [section('conventions', 'project body', { mergeStrategy: 'prepend' })]),
  ]);
  assert.strictEqual(
    byKey(res, 'conventions').body,
    'project body\n\nglobal body',
    'prepend must add before the accumulated body',
  );
}

// --- append/prepend without a predecessor: body alone, no blank prefix ----

{
  const appended = resolveHarness([
    level('project', [section('solo', 'only body', { mergeStrategy: 'append' })]),
  ]);
  assert.strictEqual(byKey(appended, 'solo').body, 'only body', 'append without predecessor');

  const prepended = resolveHarness([
    level('project', [section('solo', 'only body', { mergeStrategy: 'prepend' })]),
  ]);
  assert.strictEqual(byKey(prepended, 'solo').body, 'only body', 'prepend without predecessor');
}

// --- tombstone: enabled:false on a higher level removes the section -------

{
  const res = resolveHarness([
    level('global', [section('no-force-push', 'never force-push')]),
    level('project', [section('no-force-push', '', { enabled: false })]),
  ]);
  assert.strictEqual(byKey(res, 'no-force-push'), undefined, 'tombstoned section must be gone');
  assert.deepStrictEqual(
    res.suppressed,
    [{ key: 'no-force-push', scope: 'project' }],
    'tombstone must be reported in suppressed[] so the UI can show it',
  );
}

// --- tombstone can be lifted again further down the chain -----------------

{
  const res = resolveHarness([
    level('global', [section('rule', 'global rule')]),
    level('customer', [section('rule', '', { enabled: false })]),
    level('project', [section('rule', 'project rule')]),
  ]);
  assert.strictEqual(byKey(res, 'rule').body, 'project rule', 're-enabled section must return');
  assert.deepStrictEqual(res.suppressed, [], 'suppressed must be cleared on re-enable');
}

// --- whole level disabled is skipped entirely ----------------------------

{
  const res = resolveHarness([
    level('global', [section('a', 'global a')]),
    level('customer', [section('a', 'customer a')], { enabled: false }),
  ]);
  assert.strictEqual(byKey(res, 'a').body, 'global a', 'disabled level must not contribute');
  assert.deepStrictEqual(
    res.resolvedFrom.map((l) => l.scope),
    ['global'],
    'disabled level must not appear in resolvedFrom',
  );
}

// --- empty middle level (global + project, no customer) ------------------

{
  const res = resolveHarness([
    level('global', [section('a', 'global a')]),
    level('project', [section('b', 'project b')]),
  ]);
  assert.deepStrictEqual(
    res.sections.map((s) => s.key).sort(),
    ['a', 'b'],
    'both levels must contribute when the middle level is absent',
  );
}

// --- multi-customer: merges in the order handed in -----------------------

{
  const res = resolveHarness([
    level('global', [section('stack', 'base')]),
    level('customer', [section('stack', 'first', { mergeStrategy: 'append' })], {
      customerId: 'c1',
    }),
    level('customer', [section('stack', 'second', { mergeStrategy: 'append' })], {
      customerId: 'c2',
    }),
  ]);
  assert.strictEqual(
    byKey(res, 'stack').body,
    'base\n\nfirst\n\nsecond',
    'customer levels must merge in the given order',
  );
  assert.deepStrictEqual(
    res.resolvedFrom.map((l) => l.customerId),
    [undefined, 'c1', 'c2'],
    'resolvedFrom must name every customer level in merge order',
  );
  assert.deepStrictEqual(
    byKey(res, 'stack').origin.map((o) => o.scope),
    ['global', 'customer', 'customer'],
    'origin must record every contributing level',
  );
}

// --- unknown kind passes through (forward-compat for H2/H3) --------------

{
  const res = resolveHarness([
    level('project', [section('future', 'payload-ish', { kind: 'something-new' })]),
  ]);
  assert.strictEqual(byKey(res, 'future').kind, 'something-new', 'unknown kind must survive');
}

// --- duplicate key within ONE level: last wins, no self-merge -----------

{
  const res = resolveHarness([
    level('project', [
      section('dup', 'first', { mergeStrategy: 'append' }),
      section('dup', 'second', { mergeStrategy: 'append' }),
    ]),
  ]);
  assert.strictEqual(
    byKey(res, 'dup').body,
    'second',
    'duplicate key inside one level must not merge with itself — last wins',
  );
}

// --- order: higher level wins, missing order is inherited ---------------

{
  const res = resolveHarness([
    level('global', [
      section('z', 'z body', { order: 1 }),
      section('a', 'a body', { order: 2 }),
    ]),
    level('project', [section('a', 'a override', { order: 0 })]),
  ]);
  assert.deepStrictEqual(
    res.sections.map((s) => s.key),
    ['a', 'z'],
    'sections must be sorted by order ascending',
  );

  const inherited = resolveHarness([
    level('global', [section('keep', 'body', { order: 7 })]),
    level('project', [section('keep', 'override', { order: undefined })]),
  ]);
  assert.strictEqual(byKey(inherited, 'keep').order, 7, 'missing order must be inherited');
}

// --- payload and title: higher level wins, otherwise inherited ----------

{
  const res = resolveHarness([
    level('global', [section('p', 'body', { payload: { a: 1 }, title: 'Global Title' })]),
    level('project', [section('p', 'body2', { payload: undefined, title: '' })]),
  ]);
  assert.deepStrictEqual(byKey(res, 'p').payload, { a: 1 }, 'missing payload must be inherited');
  assert.strictEqual(byKey(res, 'p').title, 'Global Title', 'empty title must be inherited');
}

// --- markdown rendering --------------------------------------------------

{
  const res = resolveHarness([
    level('global', [
      section('second', 'Second body', { title: 'Second', order: 2 }),
      section('first', 'First body', { title: 'First', order: 1 }),
    ]),
  ]);
  assert.strictEqual(
    res.markdown,
    '## First\n\nFirst body\n\n## Second\n\nSecond body',
    'markdown must follow section order and use level-2 headings',
  );
}

// --- markdown: a section without a title renders its body alone ----------

{
  const res = resolveHarness([level('project', [section('untitled', 'Just body', { title: '' })])]);
  assert.strictEqual(
    res.markdown,
    'Just body',
    'an empty title must not produce a bare "## " heading',
  );
}

// --- empty input ---------------------------------------------------------

{
  const res = resolveHarness([]);
  assert.deepStrictEqual(res.sections, [], 'no levels must yield no sections');
  assert.deepStrictEqual(res.resolvedFrom, [], 'no levels must yield an empty chain');
  assert.strictEqual(res.markdown, '', 'no levels must yield empty markdown');
}

// --- resolver must not mutate its input ---------------------------------

{
  const input = [
    level('global', [section('a', 'global a')]),
    level('project', [section('a', 'project a', { mergeStrategy: 'append' })]),
  ];
  const snapshot = JSON.stringify(input);
  resolveHarness(input);
  assert.strictEqual(JSON.stringify(input), snapshot, 'resolveHarness must not mutate its input');
}

console.log('harness-resolve-units-check OK');
