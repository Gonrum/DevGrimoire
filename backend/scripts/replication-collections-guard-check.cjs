#!/usr/bin/env node
/*
 * Completeness guard: every projectId-bearing @Schema class under
 * backend/src must be either in REPLICATED_COLLECTIONS or in
 * EXCLUDED_COLLECTIONS (with a reason). Scans SOURCE (not dist) so a newly
 * added schema with a projectId prop breaks the build until classified.
 *
 * Run via `npm run check:replication-collections-guard` after a build.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const reg = loadCompiled('replication/replication-collections.js');
const SRC = path.resolve(__dirname, '..', 'src');

// The projects collection is the replication root — scoped by its own _id, not
// a projectId field — so it never appears in the source scan. Exempt it from
// the stale-registration check.
// ResearchSession uses `projectIds` (plural array field), so the `\bprojectId\b`
// heuristic does not match it — exempt from stale check as well.
const STALE_EXEMPT = new Set(['Project', 'ResearchSession']);

/** Recursively collect all *.schema.ts files under src/. */
function schemaFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...schemaFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.schema.ts')) out.push(full);
  }
  return out;
}

/**
 * Embedded subdocuments are declared `@Schema({ _id: false })` and are never
 * standalone collections, even if they carry a projectId field (e.g. a
 * promoted reference in note.schema.ts). Collect their class names to skip.
 */
function embeddedClasses(source) {
  const out = new Set();
  const re = /@Schema\(\{[^}]*_id:\s*false[^}]*\}\)\s*export class (\w+)/g;
  let m;
  while ((m = re.exec(source)) !== null) out.add(m[1]);
  return out;
}

/**
 * Extract class names that own a `projectId` @Prop, EXCLUDING embedded
 * (`_id: false`) subdocs. We split the file into class blocks (`export class
 * X { ... }` up to the next `export class`) and keep those whose block
 * declares `projectId` and are not embedded subdocs.
 */
function projectIdClasses(source) {
  const embedded = embeddedClasses(source);
  const classes = [];
  const re = /export class (\w+)/g;
  const marks = [];
  let m;
  while ((m = re.exec(source)) !== null) marks.push({ name: m[1], idx: m.index });
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].idx;
    const end = i + 1 < marks.length ? marks[i + 1].idx : source.length;
    const block = source.slice(start, end);
    if (/\bprojectId\b/.test(block) && !embedded.has(marks[i].name)) classes.push(marks[i].name);
  }
  return classes;
}

const included = new Set(reg.REPLICATED_COLLECTIONS.map((c) => c.className));
const excluded = new Set(reg.EXCLUDED_COLLECTIONS.map((c) => c.className));

let failures = 0;
let total = 0;
function check(label, fn) {
  total += 1;
  try {
    fn();
    console.log(`✓ ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err.message || err}`);
  }
}

const found = new Set();
for (const file of schemaFiles(SRC)) {
  const source = fs.readFileSync(file, 'utf8');
  for (const cls of projectIdClasses(source)) found.add(cls);
}

check('jede projectId-tragende Schema-Klasse ist klassifiziert', () => {
  const unclassified = [...found].filter((c) => !included.has(c) && !excluded.has(c));
  assert.deepEqual(
    unclassified,
    [],
    `Nicht klassifizierte projectId-Schemas (registrieren oder exkludieren):\n    ${unclassified.join('\n    ')}`,
  );
});

check('Registry referenziert keine verschwundene Klasse', () => {
  const stale = [...included].filter((c) => !found.has(c) && !STALE_EXEMPT.has(c));
  assert.deepEqual(stale, [], `Registrierte Klassen ohne projectId-Schema im Source:\n    ${stale.join('\n    ')}`);
});

console.log(`\n${total - failures}/${total} passed (${found.size} projectId-Schemas gescannt)`);
process.exit(failures > 0 ? 1 : 0);
