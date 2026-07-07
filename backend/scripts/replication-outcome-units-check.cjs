'use strict';
// Pure-unit check for isTerminalOutcome. Run: npm run check:replication-outcome (after build).
const assert = require('node:assert/strict');
const { isTerminalOutcome } = require('../dist/replication/replication-sync-cursor.helpers');

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { failed++; console.error(`  FAIL ${label}\n       ${e.message}`); }
}

check('every non-transient outcome is terminal', () => {
  for (const o of ['applied','skipped_lww','skipped_optin','skipped_echo','skipped_notreplicated','skipped_invalid']) {
    assert.equal(isTerminalOutcome(o), true, o);
  }
});
check('error_transient is NOT terminal', () => {
  assert.equal(isTerminalOutcome('error_transient'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
