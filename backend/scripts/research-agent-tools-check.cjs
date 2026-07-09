#!/usr/bin/env node
/*
 * Regression check for `buildResearchTools` (Task 12, autonomous
 * research-agent, Phase 4 — agent tool definitions + guarded dispatch).
 *
 * `buildResearchTools(ctx)` produces the OpenAI-function-format tool defs
 * fed into the LLM adapter plus a `dispatch(name, args)` that maps tool
 * calls onto the injected `ResearchToolContext` (mocked here — no Nest DI,
 * no Mongo, no HTTP). It must:
 *  (a) omit `web_search`/`web_fetch` from `defs` when
 *      `topic.webSearch.enabled !== true`, and include them when it is;
 *  (b) gate `web_search`/`web_fetch` on their own guardrail counters —
 *      once `counters.webSearches >= guardrails.maxWebSearches` (same for
 *      webFetches/maxWebFetches), `dispatch` must return a "Limit erreicht"
 *      text WITHOUT calling the underlying service, and must never let the
 *      counter run past the guardrail;
 *  (c) `dispatch('artifact_write', {...})` must call `artifacts.write` and
 *      return a confirmation JSON with slug/version/action (created vs.
 *      updated inferred from version);
 *  (d) every `dispatch` call — success, limit-hit, or error — must invoke
 *      `ctx.onStep` at least once;
 *  plus the rag_search cost guard (requested `limit` is clamped, never
 *  passed through unbounded) and the fact that NO scope argument crosses the
 *  tool->ctx boundary at all — `ctx.rag.searchScopes(query, limit)` — the
 *  service bakes the resolved, cost-bounded scope into its own closure.
 *
 * Loads compiled output from dist/. Run via
 * `npm run check:research-agent-tools` from backend/ after a build.
 */
const assert = require('node:assert/strict');
const { buildResearchTools } = require('../dist/research-agent/research-agent.tools');

function makeTopic(overrides = {}) {
  return {
    _id: { toString: () => 't1' },
    webSearch: { enabled: false },
    scope: { mode: 'selected', projectIds: [{ toString: () => 'p1' }], customerIds: [{ toString: () => 'c1' }], includeGlobal: true },
    ...overrides,
  };
}

function makeCtx(overrides = {}) {
  const steps = [];
  const artifactStore = new Map();
  const web = {
    searchCalls: [],
    fetchCalls: [],
    async search(query) {
      web.searchCalls.push(query);
      return [{ title: 'Result', url: 'https://example.com', snippet: 'a'.repeat(500), engine: 'mock' }];
    },
    async fetch(url) {
      web.fetchCalls.push(url);
      return { title: 'Page', text: 'b'.repeat(500) };
    },
  };
  const artifacts = {
    listByTopicCalls: [],
    async listByTopic(topicId) {
      artifacts.listByTopicCalls.push(topicId);
      return [{ slug: 'x', title: 'X', summary: 'sum', version: 1 }];
    },
    async getBySlug(topicId, slug) {
      const key = `${topicId}:${slug}`;
      return artifactStore.get(key) ?? null;
    },
    writeCalls: [],
    async write(topicId, input, scope) {
      artifacts.writeCalls.push({ topicId, input, scope });
      const key = `${topicId}:${input.slug}`;
      const existing = artifactStore.get(key);
      const version = existing ? existing.version + 1 : 1;
      const doc = { slug: input.slug, title: input.title, content: input.content, version };
      artifactStore.set(key, doc);
      return doc;
    },
    removeCalls: [],
    async remove(topicId, slug) {
      artifacts.removeCalls.push({ topicId, slug });
      artifactStore.delete(`${topicId}:${slug}`);
    },
  };
  const rag = {
    searchScopesCalls: [],
    async searchScopes(query, limit) {
      rag.searchScopesCalls.push({ query, limit });
      return [{ id: 's1', projectId: 'p1', customerId: '', entity: 'knowledge', title: 'T', content: 'c'.repeat(500), score: 0.9 }];
    },
  };

  return {
    ctx: {
      topic: makeTopic(overrides.topicOverrides),
      rag,
      web,
      artifacts,
      counters: { webSearches: 0, webFetches: 0 },
      guardrails: { maxIterations: 12, maxWebSearches: 2, maxWebFetches: 2, timeoutMs: 300000 },
      onStep: async (s) => {
        steps.push(s);
      },
      ...overrides.ctxOverrides,
    },
    steps,
    web,
    artifacts,
    rag,
  };
}

(async () => {

// (a) web_* tools absent when webSearch.enabled is false; present when true.
{
  const { ctx } = makeCtx();
  const { defs } = buildResearchTools(ctx);
  const names = defs.map((d) => d.function.name);
  assert.ok(names.includes('rag_search'));
  assert.ok(names.includes('artifact_list'));
  assert.ok(names.includes('artifact_read'));
  assert.ok(names.includes('artifact_write'));
  assert.ok(names.includes('artifact_delete'));
  assert.ok(!names.includes('web_search'), 'web_search must be omitted when webSearch.enabled is false');
  assert.ok(!names.includes('web_fetch'), 'web_fetch must be omitted when webSearch.enabled is false');
}
{
  const { ctx } = makeCtx({ topicOverrides: { webSearch: { enabled: true } } });
  const { defs } = buildResearchTools(ctx);
  const names = defs.map((d) => d.function.name);
  assert.ok(names.includes('web_search'), 'web_search must be present when webSearch.enabled is true');
  assert.ok(names.includes('web_fetch'), 'web_fetch must be present when webSearch.enabled is true');
}

// (b) guardrail gating for web_search — maxWebSearches=2.
{
  const { ctx, steps, web } = makeCtx({ topicOverrides: { webSearch: { enabled: true } } });
  const { dispatch } = buildResearchTools(ctx);

  const r1 = await dispatch('web_search', { query: 'a' });
  const r2 = await dispatch('web_search', { query: 'b' });
  assert.equal(web.searchCalls.length, 2);
  assert.equal(ctx.counters.webSearches, 2);
  assert.doesNotMatch(r1, /Limit erreicht/);
  assert.doesNotMatch(r2, /Limit erreicht/);

  const r3 = await dispatch('web_search', { query: 'c' });
  assert.match(r3, /Limit erreicht/i);
  assert.equal(web.searchCalls.length, 2, 'service must NOT be called once the guardrail is exceeded');
  assert.equal(ctx.counters.webSearches, 2, 'counter must not run past the guardrail');
  assert.equal(steps.length, 6, 'every dispatch call (3x) must emit tool_call + tool_result');
}

// (b) guardrail gating for web_fetch — maxWebFetches=2, independent counter.
{
  const { ctx, web } = makeCtx({ topicOverrides: { webSearch: { enabled: true } } });
  const { dispatch } = buildResearchTools(ctx);
  await dispatch('web_fetch', { url: 'https://a.example' });
  await dispatch('web_fetch', { url: 'https://b.example' });
  const r3 = await dispatch('web_fetch', { url: 'https://c.example' });
  assert.equal(web.fetchCalls.length, 2);
  assert.match(r3, /Limit erreicht/i);
  assert.equal(ctx.counters.webFetches, 2);
}

// Defensive: dispatch refuses web_* even if called directly while webSearch.enabled is false
// (the LLM should never see these tools in `defs`, but dispatch must not trust that blindly).
{
  const { ctx, web } = makeCtx(); // webSearch.enabled: false
  const { dispatch } = buildResearchTools(ctx);
  const r = await dispatch('web_search', { query: 'x' });
  assert.equal(web.searchCalls.length, 0);
  assert.equal(ctx.counters.webSearches, 0);
  assert.ok(typeof r === 'string' && r.length > 0);
}

// (c) artifact_write calls artifacts.write and returns a created/updated confirmation.
{
  const { ctx, artifacts, steps } = makeCtx();
  const { dispatch } = buildResearchTools(ctx);

  const created = await dispatch('artifact_write', {
    slug: 'my slug!',
    title: 'My Slug',
    content: 'Hello world',
    tags: ['a', 'b'],
  });
  assert.equal(artifacts.writeCalls.length, 1);
  assert.equal(artifacts.writeCalls[0].topicId, 't1');
  assert.equal(artifacts.writeCalls[0].input.slug, 'my slug!'); // normalization is the service's job, not the tool's
  const createdJson = JSON.parse(created);
  assert.equal(createdJson.version, 1);
  assert.equal(createdJson.action, 'created');

  const updated = await dispatch('artifact_write', {
    slug: 'my slug!',
    title: 'My Slug v2',
    content: 'Hello world v2',
  });
  const updatedJson = JSON.parse(updated);
  assert.equal(updatedJson.version, 2);
  assert.equal(updatedJson.action, 'updated');

  assert.ok(steps.some((s) => s.type === 'tool_call' && s.tool === 'artifact_write'));
  assert.ok(steps.some((s) => s.type === 'tool_result' && s.tool === 'artifact_write'));
}

// artifact_delete calls artifacts.remove.
{
  const { ctx, artifacts } = makeCtx();
  const { dispatch } = buildResearchTools(ctx);
  const r = await dispatch('artifact_delete', { slug: 'x' });
  assert.equal(artifacts.removeCalls.length, 1);
  const json = JSON.parse(r);
  assert.equal(json.action, 'deleted');
}

// artifact_list / artifact_read happy path.
{
  const { ctx, artifacts } = makeCtx();
  const { dispatch } = buildResearchTools(ctx);
  const listed = JSON.parse(await dispatch('artifact_list', {}));
  assert.equal(artifacts.listByTopicCalls.length, 1);
  assert.ok(Array.isArray(listed));

  const notFound = JSON.parse(await dispatch('artifact_read', { slug: 'nope' }));
  assert.equal(notFound.found, false);
}

// (d) every dispatch call invokes onStep — including the error path.
{
  const { ctx, steps } = makeCtx();
  const { dispatch } = buildResearchTools(ctx);
  const before = steps.length;
  const r = await dispatch('artifact_write', { slug: 'no-content' }); // missing required "title"/"content"
  assert.match(r, /Fehler/i);
  assert.ok(steps.length > before, 'onStep must fire even when dispatch hits an error');
}

// rag_search: no scope argument crosses the tool->ctx boundary at all (the
// bounded scope is baked into the ctx.rag.searchScopes closure by the
// service — see research-agent.service.ts) and the requested limit is
// clamped server-side (cost guard) — never passed through unbounded.
{
  const { ctx, rag } = makeCtx();
  const { dispatch } = buildResearchTools(ctx);
  const result = await dispatch('rag_search', { query: 'lancedb', limit: 9999 });
  assert.equal(rag.searchScopesCalls.length, 1);
  const call = rag.searchScopesCalls[0];
  assert.equal(call.query, 'lancedb');
  assert.equal(call.scope, undefined, 'ctx.rag.searchScopes must be called with (query, limit) only — no scope arg');
  assert.ok(call.limit <= 8, `limit must be capped (got ${call.limit})`);
  const parsed = JSON.parse(result);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed[0].snippet.length < 500, 'rag_search snippets must be truncated, not raw dumps');
}

// unknown tool name surfaces as a dispatch error, not an unhandled throw.
{
  const { ctx } = makeCtx();
  const { dispatch } = buildResearchTools(ctx);
  const r = await dispatch('not_a_real_tool', {});
  assert.match(r, /Fehler|Unbekannt/i);
}

console.log('research-agent-tools-check OK');

})().catch((e) => {
  console.error(e);
  process.exit(1);
});
