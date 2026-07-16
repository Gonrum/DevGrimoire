'use strict';
// Pure-unit checks for backoff/classification helpers. Run: npm run check:replication-backoff (after build).
const assert = require('node:assert/strict');
const {
  classifyHttpError,
  computeBackoffMs,
  deriveDirectionState,
  directionAlert,
  ALERT_THRESHOLD,
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

// directionAlert (debounced)
check('directionAlert: terminal error alerts once', () => {
  const a = directionAlert(false, 'error', 1);
  assert.deepEqual(a, { action: 'alert', alerted: true });
  // already alerted → no repeat
  assert.deepEqual(directionAlert(true, 'error', 3), { action: 'none', alerted: true });
});
check('directionAlert: degraded alerts only past ALERT_THRESHOLD', () => {
  assert.deepEqual(directionAlert(false, 'degraded', ALERT_THRESHOLD - 1), { action: 'none', alerted: false });
  assert.deepEqual(directionAlert(false, 'degraded', ALERT_THRESHOLD), { action: 'alert', alerted: true });
});
check('directionAlert: recovers once on return to healthy', () => {
  assert.deepEqual(directionAlert(true, 'healthy', 0), { action: 'recover', alerted: false });
  // not previously alerted → healthy is a no-op
  assert.deepEqual(directionAlert(false, 'healthy', 0), { action: 'none', alerted: false });
});
check('directionAlert: stays alerted while degraded between error and healthy', () => {
  // was alerted, now degraded but below threshold → hold the alert, no recover yet
  assert.deepEqual(directionAlert(true, 'degraded', 1), { action: 'none', alerted: true });
});
check('directionAlert: paused (driver off) does not alert or recover', () => {
  assert.deepEqual(directionAlert(false, 'paused', 0), { action: 'none', alerted: false });
  assert.deepEqual(directionAlert(true, 'paused', 0), { action: 'none', alerted: true });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
