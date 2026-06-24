#!/usr/bin/env node
/* Pure-logic check for sync helpers. Loads dist/. Run via npm run check:replication-sync after build. */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); }
  catch (err) { console.error(`Failed to load ${abs}. Run \`npm run build\` first.\n${err.message}`); process.exit(2); }
}

const h = loadCompiled('replication/replication-sync.helpers.js');

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err.message || err}`); }
}

check('toMs handles Date, ISO string, null, garbage', () => {
  assert.equal(h.toMs(new Date(1000)), 1000);
  assert.equal(h.toMs('2030-01-01T00:00:00.000Z'), Date.parse('2030-01-01T00:00:00.000Z'));
  assert.equal(h.toMs(null), null);
  assert.equal(h.toMs('not-a-date'), null);
});

check('toSyncEntry maps fields + coerces types', () => {
  const e = h.toSyncEntry({ seq: '5', eventId: 'x', op: 'upsert', collection: 'todos', documentId: 'abc', projectId: 'p1', document: { a: 1 }, updatedAtMs: '99', deletedAtMs: null, originInstanceId: 'inst-a', _id: 'ignore', createdAt: 'ignore' });
  assert.equal(e.seq, 5);
  assert.equal(e.op, 'upsert');
  assert.equal(e.updatedAtMs, 99);
  assert.equal(e.deletedAtMs, null);
  assert.equal(e.document.a, 1);
  assert.equal(e._id, undefined);
});

check('toSyncEntry: unknown op coerces to upsert; null projectId stays null', () => {
  assert.equal(h.toSyncEntry({ seq: 1, op: 'replace', projectId: null }).op, 'upsert');
  assert.equal(h.toSyncEntry({ seq: 1, op: 'delete', projectId: null }).op, 'delete');
  assert.equal(h.toSyncEntry({ seq: 1, projectId: null }).projectId, null);
});

check('pullPage keeps only origin===self, computes nextSince + hasMore', () => {
  const entries = [
    { seq: 10, originInstanceId: 'self' },
    { seq: 11, originInstanceId: 'peer' },
    { seq: 12, originInstanceId: 'self' },
  ];
  const r = h.pullPage(entries, 'self', 3);
  assert.equal(r.page.length, 2);
  assert.deepEqual(r.page.map((e) => e.seq), [10, 12]);
  assert.equal(r.nextSince, 12);   // max scanned incl. the filtered peer entry
  assert.equal(r.hasMore, true);   // window was full (3 == limit)
});

check('pullPage: short window => hasMore false; empty => nextSince 0', () => {
  const r1 = h.pullPage([{ seq: 5, originInstanceId: 'self' }], 'self', 10);
  assert.equal(r1.hasMore, false);
  assert.equal(r1.nextSince, 5);
  const r2 = h.pullPage([], 'self', 10);
  assert.equal(r2.nextSince, 0);
  assert.equal(r2.hasMore, false);
  assert.equal(r2.page.length, 0);
});

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
