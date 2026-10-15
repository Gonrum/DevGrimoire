#!/usr/bin/env node
/*
 * Recherche-LLM-Aufrufe (Webrecherche Plan 1, Task 2).
 *
 * Ein Slot pro Aufruf, genau eine Freigabe je Slot auf jedem Ausgang
 * (Erfolg, Fehler mit Umleitung, Abbruch), Lane-Bindung, Deltas in die Lane,
 * Reasoning aus dem OpenAI-Protokoll, leere tools weggelassen.
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { ResearchLlmService, Interrupted, splitThink, budgetExhausted, LIMITS } = loadCompiled('research/research-llm.service.js');
const { ResearchLiveService } = loadCompiled('research/research-live.service.js');
const { EndpointAllocator } = loadCompiled('balancer/endpoint-allocator.service.js');
const { readOpenAiChoiceDelta } = loadCompiled('balancer/llm-responses.js');
const { LlmClient } = loadCompiled('balancer/llm-client.service.js');

const EXPECTED_CHECKS = 19;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const EP = (id) => ({ id, provider: 'openai-compatible', baseUrl: `http://${id}:1234`, model: 'm', concurrency: 1, timeoutMs: 1000, visionCapable: false });

function makeEnv({ endpoints = [EP('a'), EP('b')], behaviour = () => ({ events: [{ type: 'content', delta: 'hi' }, { type: 'finish', reason: 'stop' }] }) } = {}) {
  const health = { ok: new Set(endpoints.map((e) => e.id)), isHealthy: (id) => health.ok.has(id), recordSuccess() {}, recordFailure: (_id) => { health.failed = (health.failed || 0) + 1; } };
  const allocator = new EndpointAllocator({ listForPool: async () => endpoints }, health);
  const counts = { acquire: 0, release: 0, calls: [] };
  const origAcquire = allocator.acquire.bind(allocator);
  allocator.acquire = async (...a) => { const s = await origAcquire(...a); if (s) counts.acquire += 1; return s; };
  const origRelease = allocator.release.bind(allocator);
  allocator.release = (id) => { counts.release += 1; origRelease(id); };
  const client = {
    async *chatStreamOpenAiTools(o) {
      counts.calls.push(o.baseUrl);
      const b = behaviour(o, counts.calls.length);
      if (b.throws) throw b.throws;
      for (const ev of b.events) {
        if (o.signal.aborted) throw new Error('aborted');
        if (b.waitMs) await new Promise((r) => setTimeout(r, b.waitMs));
        yield ev;
      }
    },
    async *chatStreamAnthropicTools() { yield* []; throw new Error('nicht erwartet'); },
  };
  const live = new ResearchLiveService();
  const svc = new ResearchLlmService(allocator, { getDecryptedApiKey: async () => null }, health, client, live);
  return { svc, live, counts, health };
}
const call = (env, extra = {}) => env.svc.call({ researchId: 'r1', lane: 't1', kind: 'notes', messages: [{ role: 'user', content: 'x' }], signal: new AbortController().signal, ...extra });

(async () => {
  await check('Erfolg: ein Slot, eine Freigabe, Text und Modell', async () => {
    const env = makeEnv();
    const res = await call(env);
    assert.equal(res.text, 'hi');
    assert.match(res.model, /^m @ a:1234$/);
    assert.deepEqual([env.counts.acquire, env.counts.release], [1, 1]);
  });

  await check('Fehler am ersten Endpunkt: Umleitung auf den zweiten, beide Slots freigegeben', async () => {
    const reroutes = [];
    const env = makeEnv({ behaviour: (o, n) => (n === 1 ? { throws: new Error('boom') } : { events: [{ type: 'content', delta: 'ok' }, { type: 'finish', reason: 'stop' }] }) });
    const res = await call(env, { onReroute: (to) => reroutes.push(to) });
    assert.equal(res.text, 'ok');
    assert.deepEqual(env.counts.calls, ['http://a:1234', 'http://b:1234']);
    assert.deepEqual([env.counts.acquire, env.counts.release], [2, 2]);
    assert.deepEqual(reroutes, ['m @ b:1234']);
  });

  await check('Abbruch mitten im Strom: Interrupted, Slot frei, kein recordFailure', async () => {
    const ac = new AbortController();
    const env = makeEnv({ behaviour: () => ({ waitMs: 30, events: [{ type: 'content', delta: 'a' }, { type: 'content', delta: 'b' }, { type: 'finish', reason: 'stop' }] }) });
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(call(env, { signal: ac.signal }), (e) => e instanceof Interrupted);
    assert.deepEqual([env.counts.acquire, env.counts.release], [1, 1]);
    assert.equal(env.health.failed || 0, 0);
  });

  await check('Lane-Bindung: der zweite Aufruf derselben Lane bevorzugt den letzten Endpunkt', async () => {
    const env = makeEnv({ endpoints: [EP('a'), EP('b')] });
    env.live.setSticky('r1', 't1', 'b');
    await call(env);
    assert.deepEqual(env.counts.calls, ['http://b:1234']);
  });

  await check('Deltas landen in der Lane, Snapshot enthält den Text', async () => {
    const env = makeEnv({ behaviour: () => ({ events: [{ type: 'reasoning', delta: 'denke' }, { type: 'content', delta: 'Antwort' }, { type: 'finish', reason: 'stop' }] }) });
    env.live.begin('r1');
    const seen = [];
    env.live.subscribe('r1', (ev) => seen.push(ev.type));
    await call(env);
    const snap = env.live.snapshot('r1');
    assert.equal(snap.lanes.t1.text, 'Antwort');
    assert.equal(snap.lanes.t1.reasoning, 'denke');
    assert.ok(seen.includes('delta') && seen.includes('idle'), seen.join(','));
  });

  await check('Tool-Calls werden gesammelt zurückgegeben', async () => {
    const env = makeEnv({ behaviour: () => ({ events: [{ type: 'tool_call', id: 'c1', name: 'web_search', arguments: '{"query":"x"}' }, { type: 'finish', reason: 'tool_calls' }] }) });
    const res = await call(env, { tools: [{ type: 'function', function: { name: 'web_search', description: '', parameters: {} } }] });
    assert.deepEqual(res.toolCalls, [{ id: 'c1', name: 'web_search', arguments: '{"query":"x"}' }]);
  });

  await check('readOpenAiChoiceDelta liest reasoning_content und reasoning', async () => {
    const a = readOpenAiChoiceDelta({ choices: [{ delta: { reasoning_content: 'r1' } }] });
    const b = readOpenAiChoiceDelta({ choices: [{ delta: { reasoning: 'r2' } }] });
    assert.equal(a.reasoning, 'r1');
    assert.equal(b.reasoning, 'r2');
  });

  await check('LlmClient: leere tools werden nicht gesendet, reasoning nur mit includeReasoning', async () => {
    const bodies = [];
    const sse = 'data: {"choices":[{"delta":{"reasoning_content":"r","content":"c"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new globalThis.Response(sse, { status: 200 }); };
    try {
      const client = new LlmClient();
      const collect = async (o) => { const out = []; for await (const ev of client.chatStreamOpenAiTools(o)) out.push(ev.type); return out; };
      const base = { provider: 'openai-compatible', baseUrl: 'http://x', model: 'm', apiKey: null, messages: [{ role: 'user', content: 'q' }], temperature: 0, maxTokens: 10 };
      const without = await collect({ ...base, tools: [] });
      const withR = await collect({ ...base, tools: [], includeReasoning: true });
      assert.ok(!('tools' in bodies[0]) && !('tool_choice' in bodies[0]), JSON.stringify(bodies[0]));
      assert.ok(!without.includes('reasoning'));
      assert.ok(withR.includes('reasoning'));
    } finally { globalThis.fetch = origFetch; }
  });

  await check('baseUrl ohne Schema (gpu-host): kein Slot-Leck, Label fällt auf baseUrl zurück', async () => {
    const env = makeEnv({ endpoints: [{ ...EP('a'), baseUrl: 'gpu-host' }] });
    const res = await call(env);
    assert.equal(res.model, 'm @ gpu-host');
    assert.deepEqual([env.counts.acquire, env.counts.release], [1, 1]);
  });

  await check('baseUrl mit leerem Host (localhost:1234): Label fällt auf baseUrl zurück', async () => {
    const env = makeEnv({ endpoints: [{ ...EP('a'), baseUrl: 'localhost:1234' }] });
    const res = await call(env);
    assert.equal(res.model, 'm @ localhost:1234');
    assert.deepEqual([env.counts.acquire, env.counts.release], [1, 1]);
  });

  await check('Einziger Endpunkt fehlerhaft: sofort der Originalfehler, ohne Umleitung', async () => {
    const env = makeEnv({ endpoints: [EP('a')], behaviour: () => ({ throws: new Error('original') }) });
    const reroutes = [];
    const t0 = Date.now();
    await assert.rejects(call(env, { onReroute: (to) => reroutes.push(to) }), /original/);
    assert.ok(Date.now() - t0 < 1000);
    assert.deepEqual([env.counts.acquire, env.counts.release], [1, 1]);
    assert.equal(reroutes.length, 0);
  });

  await check('API-Key-Fehler: kein recordFailure, keine Umleitung, Slot frei', async () => {
    const env = makeEnv();
    env.svc.endpoints = { getDecryptedApiKey: async () => { throw new Error('crypto'); } };
    await assert.rejects(call(env), /crypto/);
    assert.equal(env.health.failed || 0, 0);
    assert.deepEqual([env.counts.acquire, env.counts.release], [1, 1]);
  });

  await check('<think> im Inhalt: aus dem Text entfernt, live als reasoning (Tags über Chunk-Grenzen), JSON danach bleibt', async () => {
    const chunks = ['<thi', 'nk>Plan: erst ', 'suchen</th', 'ink>\n{"enough":', 'true}'];
    const env = makeEnv({ endpoints: [EP('a')], behaviour: () => ({ events: [...chunks.map((delta) => ({ type: 'content', delta })), { type: 'finish', reason: 'stop' }] }) });
    env.live.begin('r1');
    const res = await call(env);
    assert.equal(res.text, '{"enough":true}');
    const lane = env.live.snapshot('r1').lanes.t1;
    assert.equal(lane.reasoning, 'Plan: erst suchen');
    assert.equal(lane.text, '\n{"enough":true}');
    assert.equal(res.finishReason, 'stop');
  });

  await check('splitThink: mehrere Blöcke, nie geschlossen, schließendes Tag ohne öffnendes, ohne Tags unverändert', () => {
    assert.deepEqual(splitThink('<think>a</think>X<think>b</think> Y'), { text: 'X Y', reasoning: 'a\nb' });
    assert.deepEqual(splitThink('<think>denkt und denkt'), { text: '', reasoning: 'denkt und denkt' });
    assert.deepEqual(splitThink('Antwort <think>rest'), { text: 'Antwort', reasoning: 'rest' });
    assert.deepEqual(splitThink('vorher gedacht</think>\n{"a":1}'), { text: '{"a":1}', reasoning: 'vorher gedacht' });
    assert.deepEqual(splitThink('  normal  '), { text: '  normal  ', reasoning: '' });
  });

  await check('finish length wird durchgereicht; budgetExhausted nur bei (fast) leerem Text ohne Tool-Calls', async () => {
    const env = makeEnv({ endpoints: [EP('a')], behaviour: () => ({ events: [{ type: 'content', delta: '<think>' + 'x'.repeat(50) }, { type: 'finish', reason: 'length' }] }) });
    const res = await call(env);
    assert.equal(res.finishReason, 'length');
    assert.equal(res.text, '');
    assert.equal(budgetExhausted(res), true);
    assert.equal(budgetExhausted({ ...res, text: 'Ein ganz normaler, langer Satz.' }), false);
    assert.equal(budgetExhausted({ ...res, toolCalls: [{ id: '1', name: 'x', arguments: '{}' }] }), false);
    assert.equal(budgetExhausted({ ...res, finishReason: 'stop' }), false);
  });

  await check('Slot länger belegt als die Frist des Aufrufs: wartet trotzdem und gelingt; ohne Kandidat sofort Fehler', async () => {
    const env = makeEnv({ endpoints: [EP('a')] });
    env.svc.limits = { ...LIMITS, notes: { maxTokens: 100, timeoutMs: 50 } };
    const held = await env.svc.allocator.acquire('workflow', {});
    assert.ok(held, 'Slot der anderen Lane');
    setTimeout(() => env.svc.allocator.release(held.id), 300);
    const t0 = Date.now();
    const res = await call(env);
    assert.equal(res.text, 'hi');
    assert.ok(Date.now() - t0 >= 250, 'hat gewartet');

    const none = makeEnv({ endpoints: [EP('a')] });
    none.health.ok.clear();
    const t1 = Date.now();
    await assert.rejects(call(none), /kein Endpunkt frei/);
    assert.ok(Date.now() - t1 < 200, 'ohne Kandidat nicht gewartet');

    // Abbruch beendet das Warten
    const busy = makeEnv({ endpoints: [EP('a')] });
    await busy.svc.allocator.acquire('workflow', {});
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(call(busy, { signal: ac.signal }), (e) => e instanceof Interrupted);
  });

  await check('Interrupted trägt den Namen', async () => {
    assert.equal(new Interrupted('x').name, 'Interrupted');
  });

  await check('Live: subscribe/unsubscribe auf unbekannter Id hinterlässt keinen Eintrag; emit ist No-op', async () => {
    const live = new ResearchLiveService();
    const off = live.subscribe('x', () => {});
    off();
    assert.equal(live.size(), 0);
    live.emit('y', { type: 'idle', lane: 'l' });
    assert.equal(live.size(), 0);
  });

  await check('Live: end() mit Zuhörer, danach unsubscribe → Eintrag weg; emit danach legt nichts an', async () => {
    const live = new ResearchLiveService();
    live.begin('r');
    const off = live.subscribe('r', () => {});
    live.end('r');
    assert.equal(live.size(), 1);
    off();
    assert.equal(live.size(), 0);
    live.emit('r', { type: 'idle', lane: 'l' });
    assert.equal(live.size(), 0);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) { console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`); process.exit(1); }
  process.exit(failures === 0 ? 0 : 1);
})();
