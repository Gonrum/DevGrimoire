'use strict';
// Pure-unit checks for the sync cursor/partition helpers. Loads compiled dist/.
// Run: npm run check:replication-sync-cursor  (after `npm run build`)
const assert = require('node:assert/strict');
const {
  selectSendSet,
  advanceOutbound,
  advanceInbound,
} = require('../dist/replication/replication-sync-cursor.helpers');

let passed = 0;
let failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (e) { failed++; console.error(`  FAIL ${label}\n       ${e.message}`); }
}

const SELF = 'self-id';
const PEER = 'peer-id';
function entry(seq, origin, projectId) {
  return { seq, eventId: `e${seq}`, op: 'upsert', collection: 'todos',
    documentId: `d${seq}`, projectId, document: {}, updatedAtMs: seq, deletedAtMs: null,
    originInstanceId: origin };
}

// selectSendSet: keep only self-origin AND opted-in
check('selectSendSet keeps self-origin opted-in', () => {
  const en = new Set(['p1']);
  const out = selectSendSet([
    entry(1, SELF, 'p1'),   // keep
    entry(2, PEER, 'p1'),   // drop: peer origin
    entry(3, SELF, 'p2'),   // drop: not opted-in
    entry(4, SELF, null),   // drop: no projectId
    entry(5, SELF, 'p1'),   // keep
  ], SELF, en);
  assert.deepEqual(out.map((e) => e.seq), [1, 5]);
});
check('selectSendSet empty when no self-origin opted-in', () => {
  const out = selectSendSet([entry(1, PEER, 'p1'), entry(2, SELF, 'p2')], SELF, new Set(['p1']));
  assert.deepEqual(out, []);
});
check('selectSendSet excludes deadlettered eventIds', () => {
  const en = new Set(['p1']);
  const out = selectSendSet([
    entry(1, SELF, 'p1'),
    entry(2, SELF, 'p1'),
  ], SELF, en, new Set(['e1']));  // e1 = entry(1)'s eventId
  assert.deepEqual(out.map((e) => e.seq), [2]);
});

// advanceOutbound
check('advanceOutbound pure-skip window jumps to windowMax (no send)', () => {
  assert.equal(advanceOutbound(50, null, 0, 10), 50);
});
check('advanceOutbound all sent handled jumps past trailing skips', () => {
  // window max 50, last sent 45, receiver acked 45 → cursor 50
  assert.equal(advanceOutbound(50, 45, 45, 10), 50);
});
check('advanceOutbound poison frontier stops at appliedThrough', () => {
  // sent up to 45, receiver only acked 30 → cursor 30 (not 50)
  assert.equal(advanceOutbound(50, 45, 30, 10), 30);
});
check('advanceOutbound never moves below current cursor', () => {
  // receiver acked nothing (0) below current 40 → stay at 40
  assert.equal(advanceOutbound(50, 45, 0, 40), 40);
});

// advanceInbound
check('advanceInbound all handled jumps to nextSince (incl server skips)', () => {
  const r = [{ seq: 11, handled: true }, { seq: 12, handled: true }];
  assert.equal(advanceInbound(r, 20, 10), 20);
});
check('advanceInbound empty page jumps to nextSince', () => {
  assert.equal(advanceInbound([], 20, 10), 20);
});
check('advanceInbound poison stops at last handled seq', () => {
  const r = [{ seq: 11, handled: true }, { seq: 12, handled: false }, { seq: 13, handled: true }];
  assert.equal(advanceInbound(r, 20, 10), 11);
});
check('advanceInbound first entry poison keeps current cursor', () => {
  const r = [{ seq: 11, handled: false }, { seq: 12, handled: true }];
  assert.equal(advanceInbound(r, 20, 10), 10);
});
check('advanceInbound never moves below current cursor', () => {
  assert.equal(advanceInbound([{ seq: 5, handled: true }], 6, 40), 40);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
