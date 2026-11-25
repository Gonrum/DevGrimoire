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
 *    finishes on its own — also when the cancel is seen between two content
 *    events — and must not fail over to another endpoint.
 * 5. First byte (model load / prefill, 2026-11-25): before the first data line
 *    the worker heartbeats for up to LLM_FIRST_TOKEN_TIMEOUT_MS, so a silent
 *    upstream outlives the idle window; after it the idle window applies again.
 * 4. SSE keep-alive comments (`: ping`) are not activity: a stream that only
 *    sends those still times out. The progress interval is clamped below the
 *    idle window.
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
// Pre-first-byte limit for this check (read at call time by ChatRunner.run).
const FIRST_TOKEN_MS = 1500;
process.env.LLM_FIRST_TOKEN_TIMEOUT_MS = String(FIRST_TOKEN_MS);

const { LlmClient } = loadCompiled('balancer/llm-client.service.js');
const { ChatRunner } = loadCompiled('balancer/chat-runner.service.js');
const { StreamRelay } = loadCompiled('balancer/stream-relay.service.js');
const { BalancerGateway } = loadCompiled('balancer/balancer-gateway.service.js');
const { GatewayProcessor } = loadCompiled('balancer/gateway.processor.js');
const { progressIntervalMs } = loadCompiled('balancer/chat-runner.service.js');

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

/** Endless SSE stream: `line` every 40 ms until the request is aborted. */
function endless(line) {
  return new Proxy([], { get: (t, k) => (k === 'length' ? Infinity : typeof k === 'string' && /^\d+$/.test(k) ? line : t[k]) });
}

async function cancelMidStreamAbortsUpstream() {
  const realFetch = global.fetch;
  const realSetInterval = global.setInterval;
  let upstreamSignal = null;
  const contentLine = `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`;
  global.fetch = async (_url, init) => {
    upstreamSignal = init && init.signal;
    return sseResponse(endless(contentLine), 40, upstreamSignal, { i: 0 });
  };
  // Disable the cancel poll so only the loop's own `break` path is exercised:
  // that path must end the upstream request by itself.
  global.setInterval = () => ({ unref() {}, ref() {} });
  try {
    const relay = new StreamRelay();
    const runner = new ChatRunner(new LlmClient(), relay);
    const slot = { id: 'ep', provider: 'openai-compatible', baseUrl: 'http://fake', model: 'm', timeoutMs: 30000 };
    const run = runner.run('job-m', slot, null, { withTools: true, messages: MESSAGES, tools: TOOLS });
    await sleep(200);
    relay.cancel('job-m');
    const outcome = await Promise.race([
      run.then(() => 'resolved', (e) => `rejected: ${e && e.message}`),
      sleep(2000).then(() => 'still running'),
    ]);
    assert.equal(outcome, 'resolved');
    assert.ok(upstreamSignal, 'the upstream request must carry an abort signal');
    assert.equal(upstreamSignal.aborted, true, 'breaking out of a cancelled content stream must abort the upstream request');
  } finally {
    global.fetch = realFetch;
    global.setInterval = realSetInterval;
  }
}

async function keepAliveOnlyStreamStillTimesOut() {
  const realFetch = global.fetch;
  let upstreamSignal = null;
  global.fetch = async (_url, init) => {
    upstreamSignal = init && init.signal;
    return sseResponse(endless(': ping\n\n'), 40, upstreamSignal, { i: 0 });
  };
  try {
    const { gateway } = wire({ id: 'ep', provider: 'openai-compatible', baseUrl: 'http://fake', model: 'm', timeoutMs: 30000 });
    const t0 = Date.now();
    const outcome = await Promise.race([
      collect(gateway).then(() => 'completed', (e) => `rejected: ${e && e.message}`),
      sleep(FIRST_TOKEN_MS * 3).then(() => 'still running'),
    ]);
    // Pings are not data lines, so the turn never leaves the pre-first-byte
    // phase: the heartbeat carries it, bounded by the first-token limit.
    assert.match(outcome, /no response from model within/, `keep-alive comments must not count as activity (got ${outcome})`);
    assert.ok(Date.now() - t0 >= FIRST_TOKEN_MS * 0.9, 'bounded by the first-token limit, not the idle window');
    await sleep(800); // cancel poll interval
    assert.equal(upstreamSignal && upstreamSignal.aborted, true, 'the timed-out turn must abort its upstream request');
  } finally {
    global.fetch = realFetch;
  }
}

function progressIntervalIsClamped() {
  const saved = process.env.LLM_PROGRESS_INTERVAL_MS;
  try {
    process.env.LLM_PROGRESS_INTERVAL_MS = String(IDLE_MS * 10);
    assert.ok(progressIntervalMs() <= IDLE_MS / 4, `interval ${progressIntervalMs()} must stay below a quarter of the idle window ${IDLE_MS}`);
    process.env.LLM_PROGRESS_INTERVAL_MS = '50';
    assert.equal(progressIntervalMs(), 50);
  } finally {
    process.env.LLM_PROGRESS_INTERVAL_MS = saved;
  }
}

/** SSE response with an explicit delay before each chunk; honours the request signal. */
function delayedSse(chunks, delays, signal) {
  let i = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      const d = delays[i] ?? 0;
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, d);
        if (signal) {
          if (signal.aborted) { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); return; }
          signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
        }
      });
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const CONTENT_LINE = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`;
const FINISH_LINE = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`;
const OA_SLOT = { id: 'ep', provider: 'openai-compatible', baseUrl: 'http://fake', model: 'm', timeoutMs: 30000 };

async function silentBeforeFirstByteSurvivesIdleWindow() {
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => delayedSse([CONTENT_LINE, FINISH_LINE, 'data: [DONE]\n\n'], [IDLE_MS * 2.5, 10, 10], init && init.signal);
  try {
    const { gateway } = wire(OA_SLOT);
    const t0 = Date.now();
    const events = await collect(gateway);
    const took = Date.now() - t0;
    assert.ok(took > IDLE_MS * 2 && took < FIRST_TOKEN_MS, `silence must exceed the idle window but not the first-token limit (took ${took} ms)`);
    assert.ok(events.some((e) => e.type === 'content' && e.delta === 'hi'), `content expected, got ${JSON.stringify(events)}`);
  } finally {
    global.fetch = realFetch;
  }
}

async function silentBeyondFirstTokenLimitFails() {
  const realFetch = global.fetch;
  let upstreamSignal = null;
  global.fetch = async (_url, init) => {
    upstreamSignal = init && init.signal;
    return delayedSse([CONTENT_LINE], [FIRST_TOKEN_MS * 10], upstreamSignal);
  };
  try {
    let runErr = null;
    const { gateway } = wire(OA_SLOT, (e) => { runErr = e; });
    const t0 = Date.now();
    const outcome = await Promise.race([
      collect(gateway).then(() => 'completed', (e) => `rejected: ${e && e.message}`),
      sleep(FIRST_TOKEN_MS * 4).then(() => 'still running'),
    ]);
    assert.match(outcome, /no response from model within \d+ s/, `got ${outcome}`);
    assert.ok(Date.now() - t0 >= FIRST_TOKEN_MS * 0.9, 'must not fail before the first-token limit');
    await sleep(100);
    assert.ok(runErr, 'the runner must throw');
    assert.equal(runErr.committed, false, 'nothing was published: not committed');
    assert.equal(upstreamSignal && upstreamSignal.aborted, true, 'the upstream request must be aborted');
  } finally {
    global.fetch = realFetch;
  }
}

async function silenceAfterFirstChunkStillIdlesOut() {
  const realFetch = global.fetch;
  let upstreamSignal = null;
  global.fetch = async (_url, init) => {
    upstreamSignal = init && init.signal;
    return delayedSse([CONTENT_LINE, CONTENT_LINE], [20, FIRST_TOKEN_MS * 10], upstreamSignal);
  };
  try {
    const { gateway } = wire(OA_SLOT);
    const t0 = Date.now();
    const outcome = await Promise.race([
      collect(gateway).then(() => 'completed', (e) => `rejected: ${e && e.message}`),
      sleep(IDLE_MS * 6).then(() => 'still running'),
    ]);
    assert.match(outcome, /chat pool wait timeout/, `idle window must apply after the first byte (got ${outcome})`);
    assert.ok(Date.now() - t0 < IDLE_MS * 3, 'idle timeout should fire roughly after one idle window');
    await sleep(800);
    assert.equal(upstreamSignal && upstreamSignal.aborted, true, 'the timed-out turn must abort its upstream request');
  } finally {
    global.fetch = realFetch;
  }
}

async function noEndpointStillTimesOut() {
  const relay = new StreamRelay();
  // Never leased: the job is enqueued but no worker ever runs it.
  const gateway = new BalancerGateway({ enqueue: async () => 'job-none' }, relay, {}, {}, {});
  const t0 = Date.now();
  const outcome = await Promise.race([
    collect(gateway).then(() => 'completed', (e) => `rejected: ${e && e.message}`),
    sleep(IDLE_MS * 6).then(() => 'still running'),
  ]);
  assert.match(outcome, /chat pool wait timeout/);
  assert.ok(Date.now() - t0 < IDLE_MS * 3, 'must time out after POOL_WAIT_TIMEOUT_MS, not the first-token limit');
}

async function noLeakedTimersAfterRun() {
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const liveIntervals = new Set();
  const liveTimeouts = new Set();
  const firstTokenHandles = new Set();
  let sawFirstTokenTimer = false;
  const realFetch = global.fetch;
  global.fetch = async (_url, init) => delayedSse([CONTENT_LINE, FINISH_LINE, 'data: [DONE]\n\n'], [150, 5, 5], init && init.signal);
  try {
    const relay = new StreamRelay();
    const runner = new ChatRunner(new LlmClient(), relay);
    const started = [];
    global.setInterval = (fn, ms, ...a) => { const h = realSetInterval(fn, ms, ...a); liveIntervals.add(h); started.push(h); return h; };
    global.clearInterval = (h) => { liveIntervals.delete(h); return realClearInterval(h); };
    global.setTimeout = (fn, ms, ...a) => {
      const h = realSetTimeout(fn, ms, ...a);
      liveTimeouts.add(h);
      if (ms === FIRST_TOKEN_MS) { sawFirstTokenTimer = true; firstTokenHandles.add(h); }
      return h;
    };
    global.clearTimeout = (h) => { liveTimeouts.delete(h); return realClearTimeout(h); };
    await runner.run('job-t', OA_SLOT, null, { withTools: true, messages: MESSAGES, tools: TOOLS });
    assert.ok(started.length >= 1);
    assert.equal(liveIntervals.size, 0, 'every interval must be cleared on success');
    // The first-token timer (recognised by its delay) must have been cleared too.
    assert.ok(sawFirstTokenTimer, 'the first-token timer must exist during the run');
    assert.equal([...liveTimeouts].filter((h) => firstTokenHandles.has(h)).length, 0, 'first-token timer must be cleared on success');
  } finally {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    global.fetch = realFetch;
  }
}

async function noFailoverAfterCancel() {
  const relay = new StreamRelay();
  const slots = [{ id: 'a', provider: 'openai-compatible', baseUrl: 'http://a', model: 'm', timeoutMs: 1 }, { id: 'b', provider: 'openai-compatible', baseUrl: 'http://b', model: 'm', timeoutMs: 1 }];
  const allocator = { acquire: async (_p, f) => slots.find((s) => !(f && f.exclude && f.exclude.has(s.id))) ?? null, release() {} };
  const runs = [];
  const chatRunner = {
    run: async (jobId, slot) => { runs.push(slot.id); relay.cancel(jobId); throw new Error('provider 500'); },
  };
  const proc = new GatewayProcessor(allocator, { getDecryptedApiKey: async () => null }, {}, { recordSuccess() {}, recordFailure() {} }, { record: async () => {} }, relay, chatRunner);
  const events = [];
  relay.subscribe('job-f').subscribe({ next: (e) => events.push(e) });
  await proc.process({ id: 'job-f', token: 't', timestamp: Date.now(), data: { purpose: 'chat', payload: {} } });
  assert.deepEqual(runs, ['a'], 'a cancelled job must not fail over to another endpoint');
  assert.ok(events.some((e) => e.type === 'error'), 'the job still ends its relay stream');
}

(async () => {
  const cases = [
    ['openai tool call streaming longer than the idle window', () => slowToolCallDoesNotIdleOut('openai-compatible', openAiToolChunks(20))],
    ['anthropic tool call streaming longer than the idle window', () => slowToolCallDoesNotIdleOut('anthropic', anthropicToolChunks(20))],
    ['cancel aborts the upstream request and frees the worker', cancelAbortsUpstream],
    ['cancel seen between content events aborts the upstream request', cancelMidStreamAbortsUpstream],
    ['a keep-alive-only stream hits the first-token limit', keepAliveOnlyStreamStillTimesOut],
    ['progress interval is clamped below the idle window', progressIntervalIsClamped],
    ['no failover once the job is cancelled', noFailoverAfterCancel],
    ['silence before the first byte outlives the idle window', silentBeforeFirstByteSurvivesIdleWindow],
    ['silence beyond the first-token limit fails (not committed, upstream aborted)', silentBeyondFirstTokenLimitFails],
    ['silence after the first chunk still hits the idle timeout', silenceAfterFirstChunkStillIdlesOut],
    ['no endpoint still times out after POOL_WAIT_TIMEOUT_MS', noEndpointStillTimesOut],
    ['no timer outlives a finished run', noLeakedTimersAfterRun],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e && e.message}`); }
  }
  if (failed) { console.error(`${failed} failing`); process.exit(1); }
  console.log('all balancer chat liveness checks passed');
  process.exit(0);
})();
