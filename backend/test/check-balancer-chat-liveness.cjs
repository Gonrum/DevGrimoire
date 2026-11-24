#!/usr/bin/env node
/*
 * Balancer chat turn liveness (IDE agent stall, 2026-11-24).
 *
 * 1. A tool call that streams for longer than the gateway idle window must not
 *    time out: `chatStreamOpenAiTools` buffers tool-call deltas until the end of
 *    the stream, so the worker has to report upstream activity on its own.
 * 2. Same for the Anthropic tool stream (input_json_delta is buffered too).
 * 3. A cancelled job (client abort / gateway idle timeout) must abort the
 *    upstream request instead of holding the pool slot until the provider
 *    finishes on its own, and must not fail over to another endpoint.
 *
 * Real LlmClient + ChatRunner + StreamRelay + BalancerGateway; `fetch` is a
 * scripted fake. No network, no Redis. Loads from dist/ (run `npm run build`).
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { ReadableStream } = require('node:stream/web');
const { Response } = globalThis;

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}
require(path.resolve(__dirname, '..', 'node_modules', 'reflect-metadata'));

// Gateway idle window for this check (read at call time by runChat).
const IDLE_MS = 400;
process.env.POOL_WAIT_TIMEOUT_MS = String(IDLE_MS);
process.env.LLM_PROGRESS_INTERVAL_MS = '50';

const { LlmClient } = loadCompiled('balancer/llm-client.service.js');
const { ChatRunner } = loadCompiled('balancer/chat-runner.service.js');
const { StreamRelay } = loadCompiled('balancer/stream-relay.service.js');
const { BalancerGateway } = loadCompiled('balancer/balancer-gateway.service.js');

const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SSE response whose chunks arrive `gapMs` apart; honours the request signal. */
function sseResponse(chunks, gapMs, signal, state) {
  const body = new ReadableStream({
    async pull(controller) {
      if (state.i >= chunks.length) { controller.close(); return; }
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, gapMs);
        if (signal) {
          if (signal.aborted) { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); return; }
          signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
        }
      });
      controller.enqueue(enc.encode(chunks[state.i++]));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function openAiToolChunks(n) {
  const out = [];
  out.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'ws_edit', arguments: '{' } }] } }] })}\n\n`);
  for (let i = 0; i < n; i++) {
    out.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: i === 0 ? '"path":"greet.js"' : ' ' } }] } }] })}\n\n`);
  }
  out.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
  out.push('data: [DONE]\n\n');
  return out;
}

function anthropicToolChunks(n) {
  const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const out = [ev({ type: 'message_start', message: {} })];
  out.push(ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'ws_edit', input: {} } }));
  out.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"greet.js"' } }));
  for (let i = 0; i < n; i++) out.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' ' } }));
  out.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '}' } }));
  out.push(ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }));
  out.push(ev({ type: 'message_stop' }));
  return out;
}

/** Minimal queue stand-in: enqueue runs the ChatRunner like the processor would. */
function wire(slot, onRunSettled) {
  const relay = new StreamRelay();
  const runner = new ChatRunner(new LlmClient(), relay);
  let n = 0;
  const queue = {
    enqueue: async (job) => {
      const jobId = `job-${++n}`;
      setImmediate(() => {
        runner.run(jobId, slot, 'k', { withTools: true, messages: job.payload.messages, tools: job.payload.tools })
          .then(() => onRunSettled?.(null), (e) => { onRunSettled?.(e); relay.publish(jobId, { type: 'error', status: 502, message: String(e && e.message) }); });
      });
      return jobId;
    },
  };
  const gateway = new BalancerGateway(queue, relay, {}, {}, {});
  return { gateway, relay, runner };
}

const TOOLS = [{ type: 'function', function: { name: 'ws_edit', description: 'edit', parameters: { type: 'object', properties: {} } } }];
const MESSAGES = [{ role: 'user', content: 'Ändere greet.js' }];

async function collect(gateway) {
  const events = [];
  for await (const ev of gateway.runChat({ withTools: true, messages: MESSAGES, tools: TOOLS, temperature: 0, maxTokens: 100 })) events.push(ev);
  return events;
}

async function slowToolCallDoesNotIdleOut(provider, chunks) {
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => sseResponse(chunks, 40, init && init.signal, { i: 0 });
  try {
    const { gateway } = wire({ id: 'ep', provider, baseUrl: 'http://fake', model: 'm', timeoutMs: 30000 });
    const t0 = Date.now();
    const events = await collect(gateway);
    const took = Date.now() - t0;
    assert.ok(took > IDLE_MS * 1.5, `stream must outlast the idle window to be a meaningful check (took ${took} ms)`);
    const call = events.find((e) => e.type === 'tool_call');
    assert.ok(call, `${provider}: tool_call must arrive, got ${JSON.stringify(events)}`);
    assert.equal(call.name, 'ws_edit');
    assert.deepEqual(JSON.parse(call.arguments), { path: 'greet.js' });
    assert.ok(events.some((e) => e.type === 'finish' && e.reason === 'tool_calls'), `${provider}: finish tool_calls expected`);
    assert.ok(!events.some((e) => e.type === 'progress'), 'progress is a relay-internal signal and must not reach the chat loop');
  } finally {
    global.fetch = realFetch;
  }
}

async function cancelAbortsUpstream() {
  const realFetch = global.fetch;
  let upstreamSignal = null;
  // Never finishes on its own: one keep-alive comment per 50 ms, forever.
  global.fetch = async (_url, init) => {
    upstreamSignal = init && init.signal;
    const forever = new Proxy([], { get: (t, k) => (k === 'length' ? Infinity : typeof k === 'string' && /^\d+$/.test(k) ? ': ping\n\n' : t[k]) });
    return sseResponse(forever, 50, upstreamSignal, { i: 0 });
  };
  try {
    const relay = new StreamRelay();
    const runner = new ChatRunner(new LlmClient(), relay);
    const events = [];
    const sub = relay.subscribe('job-x').subscribe({ next: (e) => events.push(e) });
    const slot = { id: 'ep', provider: 'openai-compatible', baseUrl: 'http://fake', model: 'm', timeoutMs: 30000 };
    const run = runner.run('job-x', slot, null, { withTools: true, messages: MESSAGES, tools: TOOLS });
    await sleep(200);
    relay.cancel('job-x');
    const outcome = await Promise.race([
      run.then(() => 'resolved', (e) => `rejected: ${e && e.message}`),
      sleep(3000).then(() => 'still running'),
    ]);
    assert.equal(outcome, 'resolved', 'cancelled job must end promptly and without an error (no failover, no health penalty)');
    assert.ok(upstreamSignal, 'the upstream request must carry an abort signal');
    assert.equal(upstreamSignal.aborted, true, 'cancel must abort the upstream request');
    assert.ok(events.some((e) => e.type === 'done'), 'cancelled job still ends its relay stream');
    sub.unsubscribe();
  } finally {
    global.fetch = realFetch;
  }
}

(async () => {
  const cases = [
    ['openai tool call streaming longer than the idle window', () => slowToolCallDoesNotIdleOut('openai-compatible', openAiToolChunks(20))],
    ['anthropic tool call streaming longer than the idle window', () => slowToolCallDoesNotIdleOut('anthropic', anthropicToolChunks(20))],
    ['cancel aborts the upstream request and frees the worker', cancelAbortsUpstream],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e && e.message}`); }
  }
  if (failed) { console.error(`${failed} failing`); process.exit(1); }
  console.log('all balancer chat liveness checks passed');
  process.exit(0);
})();
