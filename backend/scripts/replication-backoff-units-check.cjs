'use strict';
// Pure-unit checks for backoff/classification helpers. Run: npm run check:replication-backoff (after build).
const assert = require('node:assert/strict');
const {
  classifyHttpError,
  computeBackoffMs,
  deriveDirectionState,
} = require('../dist/replication/replication-backoff.helpers');

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { failed++; console.error(`  FAIL ${label}\n       ${e.message}`); }
}

// classifyHttpError
check('4xx auth/validation are terminal', () => {
  for (const s of [400, 401, 403, 422]) {
    assert.equal(classifyHttpError({ response: { status: s } }), 'terminal', String(s));
  }
});
check('5xx / 429 / 404 are retryable', () => {
  for (const s of [500, 502, 503, 429, 404]) {
    assert.equal(classifyHttpError({ response: { status: s } }), 'retryable', String(s));
  }
});
check('network error (no response) is retryable', () => {
  assert.equal(classifyHttpError({ code: 'ECONNREFUSED' }), 'retryable');
  assert.equal(classifyHttpError(new Error('socket hang up')), 'retryable');
  assert.equal(classifyHttpError(undefined), 'retryable');
});

// computeBackoffMs (base 20000, cap 300000)
check('backoff ramps then caps', () => {
  assert.equal(computeBackoffMs(0, 20000, 300000), 0);
  assert.equal(computeBackoffMs(1, 20000, 300000), 20000);
  assert.equal(computeBackoffMs(2, 20000, 300000), 40000);
  assert.equal(computeBackoffMs(3, 20000, 300000), 80000);
  assert.equal(computeBackoffMs(4, 20000, 300000), 160000);
  assert.equal(computeBackoffMs(5, 20000, 300000), 300000); // 320000 capped
  assert.equal(computeBackoffMs(99, 20000, 300000), 300000);
});

// deriveDirectionState
check('deriveDirectionState', () => {
  assert.equal(deriveDirectionState(false, 0, null), 'paused');
  assert.equal(deriveDirectionState(false, 3, 'terminal'), 'paused'); // inactive dominates
  assert.equal(deriveDirectionState(true, 0, null), 'healthy');
  assert.equal(deriveDirectionState(true, 2, 'retryable'), 'degraded');
  assert.equal(deriveDirectionState(true, 1, 'terminal'), 'error');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
