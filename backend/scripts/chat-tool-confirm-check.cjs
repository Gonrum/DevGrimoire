#!/usr/bin/env node
/**
 * Pause und Fortsetzung vor schreibenden Tools (T-415, M-49).
 *
 * Prüft die Zustandsmaschine von `runToolLoop` gegen Attrappen — ohne LLM,
 * ohne Datenbank. Genau das ist hier nötig: der Chat-Pool dieser Instanz hat
 * keinen erreichbaren Endpunkt, ein Live-Durchstich ist also nicht fahrbar.
 * Die Logik, an der alles hängt, lässt sich trotzdem festnageln.
 */
const assert = require('node:assert');

const { ChatController } = require('../dist/chat/chat.controller');
const { WRITE_TOOL_NAMES } = require('../dist/chat/chat-tools');

let passed = 0;
function check(name, fn) {
  return fn()
    .then(() => { passed += 1; console.log(`✓ ${name}`); })
    .catch((err) => {
      console.error(`✗ ${name}`);
      console.error(`  ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    });
}

/** Ein Controller mit genau den Diensten, die `runToolLoop` anfasst. */
function controller(opts = {}) {
  const executed = [];
  const llm = {
    // eslint-disable-next-line require-yield
    async *streamChatWithTools() {
      for (const ev of opts.events ?? []) yield ev;
    },
  };
  const tools = {
    getToolsForLlm: () => [],
    execute: async (name, args) => {
      executed.push({ name, args });
      return { success: true, result: { ok: true } };
    },
  };
  const c = new ChatController(
    {}, llm, {}, tools, {}, {}, {}, {}, {},
  );
  return { c, executed };
}

const sent = () => {
  const events = [];
  return { events, send: (e) => events.push(e) };
};

const call = (id, name) => ({ id, name, arguments: '{}' });

async function main() {
  // Ein WRITE- und ein READ-Tool aus der echten Liste, damit der Check nicht
  // an erfundenen Namen vorbeiprueft.
  const WRITE = 'milestone_create_with_todos';
  const READ = 'todo_list';
  await check('Annahme: WRITE ist schreibend, READ nicht', async () => {
    assert.ok(WRITE_TOOL_NAMES.has(WRITE), `${WRITE} muss schreibend sein`);
    assert.ok(!WRITE_TOOL_NAMES.has(READ), `${READ} darf nicht schreibend sein`);
  });

  await check('lesendes Tool laeuft ohne Pause durch', async () => {
    const { c, executed } = controller({
      events: [{ type: 'tool_call', ...call('a', READ) }, { type: 'finish', reason: 'tool_calls' }],
    });
    const out = sent();
    const res = await c.runToolLoop({
      send: out.send, abort: new AbortController(), projectId: 'p',
      effectiveAllowlist: [READ], conversation: [], persisted: [],
      startIter: 0, maxIter: 1, onEndpointSelected: () => {}, confirmWrites: true,
    });
    assert.strictEqual(res.paused, undefined, 'lesendes Tool darf nicht anhalten');
    assert.deepStrictEqual(executed.map((e) => e.name), [READ]);
  });

  await check('schreibendes Tool haelt an und fuehrt NICHT aus', async () => {
    const { c, executed } = controller({
      events: [{ type: 'tool_call', ...call('w1', WRITE) }, { type: 'finish', reason: 'tool_calls' }],
    });
    const out = sent();
    const res = await c.runToolLoop({
      send: out.send, abort: new AbortController(), projectId: 'p',
      effectiveAllowlist: [WRITE], conversation: [], persisted: [],
      startIter: 0, maxIter: 1, onEndpointSelected: () => {}, confirmWrites: true,
    });
    assert.ok(res.paused, 'muss anhalten');
    assert.strictEqual(res.paused.call.id, 'w1');
    assert.deepStrictEqual(executed, [], 'das Tool darf nicht ausgefuehrt worden sein');
    assert.ok(out.events.some((e) => e.type === 'tool_confirm' && e.id === 'w1'),
      'tool_confirm muss gesendet werden');
    assert.strictEqual(res.pendingDone, false, 'ein angehaltener Turn ist nicht fertig');
  });

  await check('die restlichen Aufrufe des Durchlaufs bleiben in der Warteschlange', async () => {
    const { c } = controller({
      events: [
        { type: 'tool_call', ...call('w1', WRITE) },
        { type: 'tool_call', ...call('r1', READ) },
        { type: 'finish', reason: 'tool_calls' },
      ],
    });
    const res = await c.runToolLoop({
      send: sent().send, abort: new AbortController(), projectId: 'p',
      effectiveAllowlist: [WRITE, READ], conversation: [], persisted: [],
      startIter: 0, maxIter: 1, onEndpointSelected: () => {}, confirmWrites: true,
    });
    assert.ok(res.paused);
    assert.deepStrictEqual(res.paused.queue.map((q) => q.id), ['r1'],
      'der noch offene Aufruf muss mitwandern, sonst geht seine Reihenfolge verloren');
  });

  await check('Resume arbeitet die Warteschlange ab, bevor das Modell erneut befragt wird', async () => {
    const { c, executed } = controller({ events: [] }); // kein weiterer Modell-Aufruf noetig
    const res = await c.runToolLoop({
      send: sent().send, abort: new AbortController(), projectId: 'p',
      effectiveAllowlist: [READ], conversation: [], persisted: [],
      startIter: 0, maxIter: 1, onEndpointSelected: () => {}, confirmWrites: true,
      initialQueue: [call('r1', READ)],
    });
    assert.deepStrictEqual(executed.map((e) => e.name), [READ]);
    assert.strictEqual(res.paused, undefined);
  });

  await check('zweites schreibendes Tool im selben Durchlauf haelt erneut an', async () => {
    const { c, executed } = controller({ events: [] });
    const res = await c.runToolLoop({
      send: sent().send, abort: new AbortController(), projectId: 'p',
      effectiveAllowlist: [WRITE], conversation: [], persisted: [],
      startIter: 0, maxIter: 1, onEndpointSelected: () => {}, confirmWrites: true,
      initialQueue: [call('w2', WRITE)],
    });
    assert.ok(res.paused, 'muss erneut anhalten');
    assert.strictEqual(res.paused.call.id, 'w2');
    assert.deepStrictEqual(executed, []);
  });

  await check('confirmWrites:false fuehrt schreibende Tools ohne Rueckfrage aus', async () => {
    // Der Browser-Modus steuert die Bestaetigung selbst; der Schalter muss
    // wirken, sonst wuerde dort doppelt gefragt.
    const { c, executed } = controller({
      events: [{ type: 'tool_call', ...call('w1', WRITE) }, { type: 'finish', reason: 'tool_calls' }],
    });
    const res = await c.runToolLoop({
      send: sent().send, abort: new AbortController(), projectId: 'p',
      effectiveAllowlist: [WRITE], conversation: [], persisted: [],
      startIter: 0, maxIter: 1, onEndpointSelected: () => {}, confirmWrites: false,
    });
    assert.strictEqual(res.paused, undefined);
    assert.deepStrictEqual(executed.map((e) => e.name), [WRITE]);
  });

  await check('ohne Tool-Calls endet der Durchlauf regulaer', async () => {
    const { c } = controller({
      events: [{ type: 'content', delta: 'Hallo' }, { type: 'finish', reason: 'stop' }],
    });
    const res = await c.runToolLoop({
      send: sent().send, abort: new AbortController(), projectId: 'p',
      effectiveAllowlist: [], conversation: [], persisted: [],
      startIter: 0, maxIter: 3, onEndpointSelected: () => {}, confirmWrites: true,
    });
    assert.strictEqual(res.pendingDone, true);
    assert.strictEqual(res.fullResponse, 'Hallo');
    assert.strictEqual(res.paused, undefined);
  });

  console.log(`\n${passed} Prüfungen bestanden.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
