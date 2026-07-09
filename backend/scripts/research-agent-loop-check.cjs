#!/usr/bin/env node
/*
 * Regression check for `runToolLoop` (Task 13, autonomous research-agent,
 * Phase 4 — CORE tool-calling loop) plus `scopeFrom`/`resolveRequestScope`
 * (Task 13's cost-bounded scope resolution for `scope.mode==='all'`).
 *
 * `runToolLoop` is deliberately dependency-free: it takes an injected
 * `llm.next(priorResults)` (mocked here — no HTTP/streaming) and a plain
 * `dispatch(name, args)` (a stand-in for Task 12's guarded
 * `buildResearchTools(ctx).dispatch`), and must:
 *  (a) terminate as soon as the LLM's turn returns no tool calls, using its
 *      final `text` as `summary`;
 *  (b) abort after exactly `maxIterations` LLM turns if the model never
 *      stops calling tools, without looping forever;
 *  (c) collect `artifactsCreated`/`artifactsUpdated` slugs by inspecting the
 *      JSON `dispatch` returns for `artifact_write` calls (the same
 *      `{slug,version,action}` shape Task 12's `execArtifactWrite` returns).
 *
 * Step-emission split (see research-agent.service.ts for the full
 * rationale): Task 12's real `dispatch` already calls `ctx.onStep` itself
 * for every `tool_call`/`tool_result` (closing over the run's onStep). If
 * `runToolLoop` ALSO emitted those two step types around every dispatch
 * call, a real run would double-record its audit trail. So `runToolLoop`
 * itself only ever emits a loop-level 'note' step (currently: the
 * maxIterations cutoff) — the mocked `dispatch` below plays the role of
 * Task 12's dispatch and calls the SAME `onStep` for tool_call/tool_result,
 * mirroring the real contract precisely.
 *
 * Run via `npm run check:research-agent-loop` from backend/ after a build.
 */
const assert = require('node:assert/strict');
const { runToolLoop } = require('../dist/research-agent/research-agent.service');
const { scopeFrom, resolveRequestScope, MAX_SCOPES } = require('../dist/research-agent/research-scope.util');

(async () => {

// (a) terminates deterministically once the LLM stops calling tools; the
// final turn's `text` becomes `summary`.
{
  let calls = 0;
  const llm = {
    next: async () =>
      calls++ === 0
        ? { text: '', toolCalls: [{ id: 'c1', name: 'artifact_write', args: { slug: 'a' } }] }
        : { text: 'fertig', toolCalls: [] },
  };
  const steps = [];
  const onStep = (s) => { steps.push(s.type); };
  const dispatch = async (name, args) => {
    await onStep({ type: 'tool_call', tool: name, argsSummary: JSON.stringify(args), ts: new Date() });
    const result = JSON.stringify({ slug: args.slug, version: 1, action: 'created' });
    await onStep({ type: 'tool_result', tool: name, resultSummary: result, ts: new Date() });
    return result;
  };

  const r = await runToolLoop({ llm, dispatch, maxIterations: 5, onStep });
  assert.equal(r.summary, 'fertig');
  assert.equal(r.iterations, 2, 'must stop right after the no-tool-call turn (2 LLM turns total)');
  assert.equal(r.hitMaxIterations, false);
  assert.ok(steps.includes('tool_call'), 'dispatch-driven tool_call step must reach the shared onStep sink');
  assert.ok(steps.includes('tool_result'));
  assert.deepEqual(r.artifactsCreated, ['a'], 'artifact_write "created" result must be collected');
  assert.deepEqual(r.artifactsUpdated, []);
}

// (b) never-terminating model → cut off at exactly maxIterations, no
// infinite loop, and the caller-visible result flags it (plus a 'note' step).
{
  const llm = {
    next: async () => ({
      text: 'immer noch dran',
      toolCalls: [{ id: 'x', name: 'rag_search', args: { query: 'q' } }],
    }),
  };
  let dispatchCalls = 0;
  const dispatch = async () => { dispatchCalls++; return '[]'; };
  const steps = [];
  const onStep = (s) => { steps.push(s.type); };

  const r = await runToolLoop({ llm, dispatch, maxIterations: 3, onStep });
  assert.equal(r.iterations, 3, 'must stop at exactly maxIterations, not loop forever');
  assert.equal(dispatchCalls, 3);
  assert.equal(r.hitMaxIterations, true);
  assert.ok(steps.includes('note'), 'maxIterations cutoff must surface a note step');
}

// (c) mixed created + updated artifacts collected across multiple tool
// calls within ONE turn, ignoring non-artifact_write calls.
{
  const calls = [
    { id: 'c1', name: 'artifact_write', args: { slug: 'new-one' } },
    { id: 'c2', name: 'artifact_write', args: { slug: 'existing-one' } },
    { id: 'c3', name: 'rag_search', args: { query: 'irrelevant' } },
  ];
  let turn = 0;
  const llm = {
    next: async () => (turn++ === 0 ? { text: '', toolCalls: calls } : { text: 'ok', toolCalls: [] }),
  };
  const dispatch = async (name, args) => {
    if (name === 'artifact_write' && args.slug === 'new-one') {
      return JSON.stringify({ slug: 'new-one', version: 1, action: 'created' });
    }
    if (name === 'artifact_write' && args.slug === 'existing-one') {
      return JSON.stringify({ slug: 'existing-one', version: 3, action: 'updated' });
    }
    return '[]';
  };

  const r = await runToolLoop({ llm, dispatch, maxIterations: 5 });
  assert.deepEqual(r.artifactsCreated, ['new-one']);
  assert.deepEqual(r.artifactsUpdated, ['existing-one']);
}

// dispatch errors (guarded dispatch never throws per Task 12 — it returns a
// "Fehler: ..." string) must not crash the loop or be mistaken for JSON.
{
  let turn = 0;
  const llm = {
    next: async () => {
      turn++;
      if (turn === 1) return { text: '', toolCalls: [{ id: 'e1', name: 'artifact_write', args: { slug: 'bad' } }] };
      return { text: 'ok', toolCalls: [] };
    },
  };
  const dispatch = async () => 'Fehler: Parameter "title" ist erforderlich';
  const r = await runToolLoop({ llm, dispatch, maxIterations: 3 });
  assert.equal(r.summary, 'ok');
  assert.deepEqual(r.artifactsCreated, []);
  assert.deepEqual(r.artifactsUpdated, []);
}

// `scopeFrom` / `resolveRequestScope` — pure scope resolution + cost bound.
{
  const selectedTopic = {
    scope: {
      mode: 'selected',
      projectIds: [{ toString: () => 'p1' }, 'p2'],
      customerIds: ['c1'],
      includeGlobal: false,
    },
  };
  const direct = scopeFrom(selectedTopic);
  assert.deepEqual(direct, { projectIds: ['p1', 'p2'], customerIds: ['c1'], includeGlobal: false });

  const resolvedSelected = resolveRequestScope(selectedTopic, { projectIds: ['ignored'], customerIds: [] });
  assert.deepEqual(resolvedSelected.scope, direct, "'selected' mode ignores the visible-ids expansion entirely");
  assert.equal(resolvedSelected.note, undefined);

  const allTopicSmall = { scope: { mode: 'all', includeGlobal: true, projectIds: [], customerIds: [] } };
  const smallVisible = { projectIds: ['p1', 'p2'], customerIds: ['c1'] };
  const resolvedSmall = resolveRequestScope(allTopicSmall, smallVisible, 25);
  assert.deepEqual(resolvedSmall.scope, { projectIds: ['p1', 'p2'], customerIds: ['c1'], includeGlobal: true });
  assert.equal(resolvedSmall.note, undefined, 'no note when under the cap');

  const manyProjects = Array.from({ length: 30 }, (_, i) => `p${i}`);
  const manyCustomers = Array.from({ length: 10 }, (_, i) => `c${i}`);
  const allTopicBig = { scope: { mode: 'all', includeGlobal: true, projectIds: [], customerIds: [] } };
  const resolvedBig = resolveRequestScope(
    allTopicBig,
    { projectIds: manyProjects, customerIds: manyCustomers },
    MAX_SCOPES,
  );
  const keptTotal = resolvedBig.scope.projectIds.length + resolvedBig.scope.customerIds.length;
  assert.equal(keptTotal, MAX_SCOPES, 'must cap the combined scope count at MAX_SCOPES');
  assert.ok(resolvedBig.note, 'truncation must produce a caller-facing note');
  assert.match(resolvedBig.note, /begrenzt/i);
  assert.match(resolvedBig.note, new RegExp(String(MAX_SCOPES)));
  assert.match(resolvedBig.note, /40/, 'note must mention the original total (30+10=40)');
}

console.log('research-agent-loop-check OK');

})().catch((e) => {
  console.error(e);
  process.exit(1);
});
