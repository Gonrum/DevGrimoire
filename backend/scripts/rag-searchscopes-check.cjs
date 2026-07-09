// Verifies the pure merge/dedup/sort/limit logic behind RagService.searchScopes:
// mergeScopeHits(hitLists, limit) dedups by source doc id (keeping the best
// score per id), sorts by score descending, and truncates to `limit`.
const assert = require('node:assert');
const { mergeScopeHits } = require('../dist/rag/rag.service');

const hit = (id, score, extra = {}) => ({
  id,
  projectId: '',
  customerId: '',
  entity: 'knowledge',
  title: `title-${id}`,
  content: `content-${id}`,
  score,
  ...extra,
});

// --- Dedup by source id: same id across scopes keeps the higher score ---
{
  const projectScope = [hit('a', 0.5), hit('b', 0.9)];
  const customerScope = [hit('a', 0.8), hit('c', 0.4)];
  const merged = mergeScopeHits([projectScope, customerScope], 10);

  assert.strictEqual(merged.length, 3, 'expected 3 unique ids after dedup');
  const byId = Object.fromEntries(merged.map((h) => [h.id, h]));
  assert.strictEqual(byId.a.score, 0.8, 'dedup must keep the higher score for duplicate id');
  assert.ok(byId.b && byId.c, 'non-duplicate ids must survive the merge');
}

// --- Sort by score descending ---
{
  const merged = mergeScopeHits([[hit('x', 0.1), hit('y', 0.7), hit('z', 0.4)]], 10);
  assert.deepStrictEqual(
    merged.map((h) => h.id),
    ['y', 'z', 'x'],
    'hits must be sorted by score descending',
  );
}

// --- Limit truncation ---
{
  const list = [hit('1', 0.9), hit('2', 0.8), hit('3', 0.7), hit('4', 0.6)];
  const merged = mergeScopeHits([list], 2);
  assert.strictEqual(merged.length, 2, 'result must be truncated to the limit');
  assert.deepStrictEqual(
    merged.map((h) => h.id),
    ['1', '2'],
    'limit must keep the top-scoring hits',
  );
}

// --- Empty input ---
{
  assert.deepStrictEqual(mergeScopeHits([], 8), [], 'no hit lists → empty result');
  assert.deepStrictEqual(mergeScopeHits([[], []], 8), [], 'only empty hit lists → empty result');
}

// --- Three-way merge (project + customer + global) with cross-scope duplicate ---
{
  const projectScope = [hit('shared', 0.6), hit('p-only', 0.95)];
  const customerScope = [hit('c-only', 0.3)];
  const globalScope = [hit('shared', 0.7)];
  const merged = mergeScopeHits([projectScope, customerScope, globalScope], 8);

  assert.strictEqual(merged.length, 3);
  assert.deepStrictEqual(
    merged.map((h) => h.id),
    ['p-only', 'shared', 'c-only'],
  );
  const shared = merged.find((h) => h.id === 'shared');
  assert.strictEqual(shared.score, 0.7, 'shared id must keep the higher of the two scores');
}

console.log('rag-searchscopes-check OK');
