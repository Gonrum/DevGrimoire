#!/usr/bin/env node
/*
 * Pure-logic check for the replication collections registry.
 * Loads compiled code from dist/. Run via
 * `npm run check:replication-collections` from backend/ after a build.
 */
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

check('keine doppelten collection-Namen', () => {
  const names = reg.replicatedCollectionNames();
  assert.equal(new Set(names).size, names.length);
});

check('keine doppelten className-Werte', () => {
  const cn = reg.REPLICATED_COLLECTIONS.map((c) => c.className);
  assert.equal(new Set(cn).size, cn.length);
});

check('jeder Eintrag hat alle Pflichtfelder', () => {
  for (const c of reg.REPLICATED_COLLECTIONS) {
    assert.ok(c.className && typeof c.className === 'string', `className fehlt: ${JSON.stringify(c)}`);
    assert.ok(c.entity && typeof c.entity === 'string', `entity fehlt: ${JSON.stringify(c)}`);
    assert.ok(c.collection && typeof c.collection === 'string', `collection fehlt: ${JSON.stringify(c)}`);
    assert.equal(typeof c.appendOnly, 'boolean', `appendOnly fehlt: ${JSON.stringify(c)}`);
  }
});

check('append-only umfasst commits + activities', () => {
  const ao = reg.appendOnlyCollections();
  assert.ok(ao.has('commits'));
  assert.ok(ao.has('activities'));
});

check('isReplicatedCollection erkennt bekannte/unbekannte', () => {
  assert.equal(reg.isReplicatedCollection('todos'), true);
  assert.equal(reg.isReplicatedCollection('workspaces'), false);
  assert.equal(reg.isReplicatedCollection('nonexistent'), false);
});

check('getReplicatedByCollection liefert Eintrag', () => {
  const c = reg.getReplicatedByCollection('knowledges');
  assert.equal(c.entity, 'knowledge');
  assert.equal(c.appendOnly, false);
});

check('keine Überschneidung registriert vs. exkludiert', () => {
  const inc = new Set(reg.REPLICATED_COLLECTIONS.map((c) => c.className));
  for (const e of reg.EXCLUDED_COLLECTIONS) {
    assert.ok(!inc.has(e.className), `${e.className} ist registriert UND exkludiert`);
    assert.ok(e.reason && e.reason.length > 0, `Grund fehlt für ${e.className}`);
  }
});

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
