#!/usr/bin/env node
/*
 * Regression check for the Harness schema + DTO validation (T-436, M-51 / H1).
 *
 * A Harness is a singleton per level (global / customer / project). That
 * invariant lives in three partial unique indexes — if one of them goes
 * missing, two competing harnesses can coexist on the same level and the
 * merge order becomes undefined. This check pins them down, plus the
 * section-key uniqueness validator and the scope/owner DTO rules.
 *
 * Loads compiled output from dist/. Run via
 * `npm run check:harness-schema` from backend/ after a build.
 */
const assert = require('node:assert');
const { plainToInstance } = require('class-transformer');
const { validateSync } = require('class-validator');
const { HarnessSchema, HarnessSectionSchema } = require('../dist/harness/schemas/harness.schema');
const { CreateHarnessDto } = require('../dist/harness/dto/create-harness.dto');
const { HarnessSectionDto } = require('../dist/harness/dto/harness-section.dto');
const {
  HARNESS_SCOPES,
  HARNESS_SECTION_KINDS,
  HARNESS_MERGE_STRATEGIES,
} = require('../dist/harness/harness.types');

// --- shared enums ---------------------------------------------------------

assert.deepStrictEqual([...HARNESS_SCOPES], ['global', 'customer', 'project']);
assert.deepStrictEqual(
  [...HARNESS_SECTION_KINDS],
  ['prose', 'bootstrap', 'block', 'constraint'],
  'block/constraint must already be allowed so H2/H3 need no schema migration',
);
assert.deepStrictEqual([...HARNESS_MERGE_STRATEGIES], ['replace', 'append', 'prepend']);

// --- singleton-per-level indexes -----------------------------------------

const indexes = HarnessSchema.indexes();
const hasPartialUnique = (field, scope) =>
  indexes.some(
    ([spec, opts]) =>
      spec[field] === 1 &&
      opts &&
      opts.unique &&
      opts.partialFilterExpression &&
      opts.partialFilterExpression.scope === scope,
  );

assert.ok(hasPartialUnique('projectId', 'project'), 'unique partial index on projectId missing');
assert.ok(hasPartialUnique('customerId', 'customer'), 'unique partial index on customerId missing');
assert.ok(
  hasPartialUnique('scope', 'global'),
  'unique partial index pinning a single global harness missing',
);

// --- title must be storable as '' so the resolver can inherit it ---------
// `required: true` on a String rejects '' in mongoose, which would make the
// resolver's title-inheritance path unreachable through the API.

assert.strictEqual(
  HarnessSectionSchema.path('title').isRequired,
  undefined,
  "title must not be required — '' means 'inherit from the lower level'",
);

// --- section keys must be unique within one harness ----------------------

const sectionsPath = HarnessSchema.path('sections');
assert.ok(sectionsPath, 'sections path missing');
assert.ok(
  sectionsPath.validators.some((v) => typeof v.validator === 'function'),
  'sections needs a validator enforcing unique keys',
);

const runSectionsValidator = (sections) =>
  sectionsPath.validators
    .filter((v) => typeof v.validator === 'function')
    .every((v) => v.validator(sections));

assert.strictEqual(
  runSectionsValidator([{ key: 'a' }, { key: 'b' }]),
  true,
  'distinct section keys must validate',
);
assert.strictEqual(
  runSectionsValidator([{ key: 'a' }, { key: 'a' }]),
  false,
  'duplicate section keys must be rejected',
);

// --- DTO: scope requires the matching owner ------------------------------

const errorsFor = (plain) =>
  validateSync(plainToInstance(CreateHarnessDto, plain), { whitelist: true })
    .flatMap((e) => Object.keys(e.constraints || {}).map(() => e.property));

const OID = '69c12580c01a0739c142f1c0';

assert.deepStrictEqual(errorsFor({ scope: 'global' }), [], 'global scope needs no owner');
assert.deepStrictEqual(
  errorsFor({ scope: 'project', projectId: OID }),
  [],
  'project scope with projectId must pass',
);
assert.deepStrictEqual(
  errorsFor({ scope: 'customer', customerId: OID }),
  [],
  'customer scope with customerId must pass',
);
assert.ok(
  errorsFor({ scope: 'project' }).includes('projectId'),
  'project scope without projectId must be rejected',
);
assert.ok(
  errorsFor({ scope: 'customer' }).includes('customerId'),
  'customer scope without customerId must be rejected',
);
assert.ok(
  errorsFor({ scope: 'global', projectId: OID }).includes('projectId'),
  'global scope must not carry a projectId',
);
assert.ok(
  errorsFor({ scope: 'project', projectId: OID, customerId: OID }).includes('customerId'),
  'project scope must not also carry a customerId',
);
assert.ok(errorsFor({ scope: 'nonsense' }).includes('scope'), 'unknown scope must be rejected');

// --- DTO: section key must be kebab-case --------------------------------

const sectionErrors = (plain) =>
  validateSync(plainToInstance(HarnessSectionDto, plain), { whitelist: true }).map(
    (e) => e.property,
  );

const validSection = { key: 'tool-usage', kind: 'prose', title: 'Tool Usage', body: 'x' };
assert.deepStrictEqual(sectionErrors(validSection), [], 'valid section must pass');
assert.deepStrictEqual(
  sectionErrors({ key: 'tool-usage', kind: 'prose', body: 'x' }),
  [],
  'a section without a title must pass — the title is then inherited',
);
assert.ok(sectionErrors({ ...validSection, key: 'Tool_Usage' }).includes('key'), 'key must be kebab-case');
assert.ok(sectionErrors({ ...validSection, key: '-lead' }).includes('key'), 'key must not start with -');
assert.ok(sectionErrors({ ...validSection, kind: 'bogus' }).includes('kind'), 'kind must be an enum value');
assert.ok(
  sectionErrors({ ...validSection, mergeStrategy: 'bogus' }).includes('mergeStrategy'),
  'mergeStrategy must be an enum value',
);

console.log('harness-schema-check OK');
