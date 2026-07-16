'use strict';
// Pure-unit checks for the replication_log GC boundary helpers. Loads compiled
// dist/. Run: npm run check:replication-gc  (after `npm run build`)
const assert = require('node:assert/strict');
const {
  DEFAULT_LOG_RETENTION_DAYS,
  resolveRetentionDays,
  logGcBound,
  isPrunable,
  RETRY_ORPHAN_HOURS,
  deadletterGcCutoffs,
} = require('../dist/replication/replication-gc.helpers');

let passed = 0;
let failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { failed++; console.error(`  FAIL ${label}\n       ${e.message}`); }
}

const MS_PER_DAY = 86_400_000;
const NOW = 1_700_000_000_000; // fixed epoch — no Date.now() so the check is deterministic

// resolveRetentionDays: default on missing/invalid/non-positive
check('resolveRetentionDays parses a positive number', () => {
  assert.equal(resolveRetentionDays('30'), 30);
  assert.equal(resolveRetentionDays(7), 7);
});
check('resolveRetentionDays falls back to default', () => {
  assert.equal(resolveRetentionDays(undefined), DEFAULT_LOG_RETENTION_DAYS);
  assert.equal(resolveRetentionDays(null), DEFAULT_LOG_RETENTION_DAYS);
  assert.equal(resolveRetentionDays('abc'), DEFAULT_LOG_RETENTION_DAYS);
  assert.equal(resolveRetentionDays('0'), DEFAULT_LOG_RETENTION_DAYS);
  assert.equal(resolveRetentionDays('-5'), DEFAULT_LOG_RETENTION_DAYS);
});

// logGcBound: cutoff is now − retention; seq guard depends on active/passive
check('logGcBound cutoff = now − retention days', () => {
  const b = logGcBound(NOW, 14, false, 100);
  assert.equal(b.cutoffMs, NOW - 14 * MS_PER_DAY);
});
check('logGcBound active driver bounds seq at the outbound cursor', () => {
  const b = logGcBound(NOW, 14, true, 100);
  assert.equal(b.maxSeqInclusive, 100);
});
check('logGcBound passive/unset has no seq bound (age only)', () => {
  const b = logGcBound(NOW, 14, false, 100);
  assert.equal(b.maxSeqInclusive, Number.MAX_SAFE_INTEGER);
});

// isPrunable: the guard must be non-vacuous — an OLD entry above the cursor is
// PROTECTED on the active driver but PRUNABLE on a passive instance.
const OLD = NOW - 30 * MS_PER_DAY;   // 30d old, past a 14d cutoff
const RECENT = NOW - 1 * MS_PER_DAY; // 1d old, inside retention

check('active: old entry at/below cursor is prunable', () => {
  const b = logGcBound(NOW, 14, true, 100);
  assert.equal(isPrunable({ createdAtMs: OLD, seq: 100 }, b), true);  // seq == cursor (<=)
  assert.equal(isPrunable({ createdAtMs: OLD, seq: 50 }, b), true);
});
check('active: old entry ABOVE cursor is PROTECTED (guard non-vacuous)', () => {
  const b = logGcBound(NOW, 14, true, 100);
  assert.equal(isPrunable({ createdAtMs: OLD, seq: 101 }, b), false); // un-pushed local write
});
check('active: recent entry below cursor is kept (age)', () => {
  const b = logGcBound(NOW, 14, true, 100);
  assert.equal(isPrunable({ createdAtMs: RECENT, seq: 50 }, b), false);
});
check('passive: SAME old-above-cursor entry IS prunable (age-only, no guard)', () => {
  const b = logGcBound(NOW, 14, false, 100);
  assert.equal(isPrunable({ createdAtMs: OLD, seq: 101 }, b), true);
});
check('boundary: createdAt exactly at cutoff is kept (strict <)', () => {
  const b = logGcBound(NOW, 14, true, 100);
  assert.equal(isPrunable({ createdAtMs: b.cutoffMs, seq: 1 }, b), false);
});

// deadletter GC cutoffs
check('deadletterGcCutoffs: resolved = now − retention days', () => {
  const c = deadletterGcCutoffs(NOW, 14);
  assert.equal(c.resolvedCutoffMs, NOW - 14 * MS_PER_DAY);
});
check('deadletterGcCutoffs: orphan window is RETRY_ORPHAN_HOURS', () => {
  const c = deadletterGcCutoffs(NOW, 14);
  assert.equal(c.orphanCutoffMs, NOW - RETRY_ORPHAN_HOURS * 3_600_000);
});
check('deadletterGcCutoffs: orphan window is much shorter than resolved', () => {
  const c = deadletterGcCutoffs(NOW, 14);
  assert.ok(c.orphanCutoffMs > c.resolvedCutoffMs, 'orphans pruned sooner than resolved history');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
