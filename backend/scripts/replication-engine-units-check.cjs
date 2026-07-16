'use strict';
// Pure-unit checks for the replication engine selector. Loads compiled dist/.
// Run: npm run check:replication-engine  (after `npm run build`)
const assert = require('node:assert/strict');
const {
  DEFAULT_ENGINE,
  resolveEngine,
  legacyEngineEnabled,
} = require('../dist/replication/replication-engine.helpers');

let passed = 0;
let failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { failed++; console.error(`  FAIL ${label}\n       ${e.message}`); }
}

check('DEFAULT_ENGINE is legacy (non-breaking default)', () => {
  assert.equal(DEFAULT_ENGINE, 'legacy');
});

check('resolveEngine: only exact "log" selects log', () => {
  assert.equal(resolveEngine('log'), 'log');
});
check('resolveEngine: unset/legacy/garbage → legacy', () => {
  assert.equal(resolveEngine(undefined), 'legacy');
  assert.equal(resolveEngine(null), 'legacy');
  assert.equal(resolveEngine(''), 'legacy');
  assert.equal(resolveEngine('legacy'), 'legacy');
  assert.equal(resolveEngine('LOG'), 'legacy');   // case-sensitive on purpose
  assert.equal(resolveEngine('nonsense'), 'legacy');
});

// The gate is the inverse: legacy surfaces run UNLESS engine is 'log'.
check('legacyEngineEnabled: true unless engine is "log"', () => {
  assert.equal(legacyEngineEnabled('log'), false);
  assert.equal(legacyEngineEnabled('legacy'), true);
  assert.equal(legacyEngineEnabled(undefined), true);  // unset → legacy stays on
  assert.equal(legacyEngineEnabled('typo'), true);     // fail safe: never silently off
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
