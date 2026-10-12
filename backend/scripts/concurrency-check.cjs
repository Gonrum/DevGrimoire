#!/usr/bin/env node
/*
 * Nebenläufigkeit (Review §8 Punkt 26: H-16, H-17, H-18, H-19, M-12, M-13, M-14).
 *
 * M-12 braucht eine echte MongoDB, weil der Fix eine Update-Pipeline mit
 * `$setField` ist: MONGODB_TEST_URI (eine Wegwerf-Datenbank; der Check legt
 * eine eigene Collection an und löscht sie wieder). Ohne die Variable wird
 * genau dieser Fall als übersprungen gemeldet — in CI ist sie gesetzt.
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { RecurringTasksService } = loadCompiled('recurring-tasks/recurring-tasks.service.js');
const { LlmClient } = loadCompiled('balancer/llm-client.service.js');
const engineMod = loadCompiled('workflows/engine/workflow-engine.service.js');
const { WorkflowEngineService, contextUpdatePipeline } = engineMod;
const { GatewayProcessor } = loadCompiled('balancer/gateway.processor.js');
const { StreamRelay } = loadCompiled('balancer/stream-relay.service.js');
const { Types } = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const EXPECTED_CHECKS = 9;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const exec = (v) => ({ exec: async () => v });

(async () => {
  await check('H-17: zwei überlappende Ticks führen einen fälligen Task genau EINMAL aus', async () => {
    const due = new Date(Date.now() - 60_000);
    const doc = { _id: new Types.ObjectId(), active: true, nextRun: due, frequency: 'daily', hour: 3, maxCatchUp: 1 };
    const model = {
      find: () => exec([{ ...doc }]),
      findOneAndUpdate: (f, u) => {
        // atomar wie Mongo: nur wer den alten nextRun noch sieht, gewinnt.
        if (String(f._id) === String(doc._id) && doc.nextRun.getTime() === new Date(f.nextRun).getTime()) {
          const before = { ...doc };
          Object.assign(doc, u.$set);
          return exec(before);
        }
        return exec(null);
      },
      findById: () => exec({ ...doc }),
      findByIdAndUpdate: () => exec(doc),
    };
    const svc = Object.create(RecurringTasksService.prototype);
    svc.recurringTaskModel = model;
    svc.logger = { error() {}, log() {}, warn() {} };
    let executed = 0;
    svc.executeTask = async () => { executed += 1; await new Promise((r) => setTimeout(r, 30)); };
    await Promise.all([svc.processDueTasks(), svc.processDueTasks()]);
    assert.equal(executed, 1, `Task lief ${executed}x`);
    assert.ok(doc.nextRun > new Date(), 'nextRun wurde nicht vorgerückt');
  });

  await check('H-16: chatNonStream bricht gegen einen Upstream ab, der nie antwortet', async () => {
    const server = http.createServer(() => { /* antwortet nie */ });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const client = Object.create(LlmClient.prototype);
      const t0 = Date.now();
      await assert.rejects(() => client.chatNonStream({
        provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${server.address().port}`,
        apiKey: null, body: {}, timeoutMs: 200,
      }));
      assert.ok(Date.now() - t0 < 3000, 'Timeout griff nicht');
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });

  await check('M-13: Engine-Timeout bricht das Signal des Executors ab', async () => {
    const eng = Object.create(WorkflowEngineService.prototype);
    const abort = new AbortController();
    const never = new Promise(() => {});
    await assert.rejects(() => eng.withTimeout(never, 50, abort), /exceeded/);
    assert.equal(abort.signal.aborted, true);
  });

  // Gemeinsames Engine-Gerüst für H-18 / M-14.
  function makeEngine({ nodeRuns, runs }) {
    const eng = Object.create(WorkflowEngineService.prototype);
    const matches = (d, f) => Object.entries(f).every(([k, v]) => {
      if (v && typeof v === 'object' && v.$in) return v.$in.map(String).includes(String(d[k]));
      if (k === '_id') return String(d._id) === String(v);
      if (k.includes('.')) { const [a, b] = k.split('.'); return d[a] && String(d[a][b]) === String(v); }
      return String(d[k]) === String(v);
    });
    eng.nodeRunModel = {
      find: (f) => exec(nodeRuns.filter((d) => matches(d, f))),
      findOneAndUpdate: (f, u) => {
        const d = nodeRuns.find((x) => matches(x, f));
        if (!d) return exec(null);
        Object.assign(d, u.$set);
        if (u.$unset) for (const k of Object.keys(u.$unset)) delete d[k];
        return exec(d);
      },
      updateMany: (f, u) => { nodeRuns.filter((d) => matches(d, f)).forEach((d) => Object.assign(d, u.$set)); return exec({}); },
      findById: (id) => exec(nodeRuns.find((d) => String(d._id) === String(id)) ?? null),
    };
    eng.runModel = {
      find: (f) => exec(runs.filter((d) => matches(d, { status: f.status }))),
      findById: (id) => exec(runs.find((d) => String(d._id) === String(id)) ?? null),
    };
    eng.logger = { warn() {}, log() {}, error() {} };
    eng.eventEmitter = { emit() {} };
    return eng;
  }
  const graph = {
    nodes: [{ id: 'trigger', type: 'trigger.manual', config: {} }, { id: 'todo', type: 'action.todo-create', config: {} }, { id: 'wait', type: 'flow.delay', config: {} }],
    edges: [{ id: 'e1', source: 'trigger', target: 'todo' }],
  };

  await check('H-18: Recovery setzt am unterbrochenen Node fort, nicht am Trigger', async () => {
    const runId = new Types.ObjectId();
    const run = { _id: runId, status: 'running', definitionSnapshot: graph, async save() {} };
    const nodeRuns = [
      { _id: new Types.ObjectId(), runId, nodeId: 'trigger', status: 'succeeded', attempt: 1 },
      { _id: new Types.ObjectId(), runId, nodeId: 'todo', status: 'running', attempt: 1 },
    ];
    const eng = makeEngine({ nodeRuns, runs: [run] });
    eng.runModel.find = (f) => exec(f.status === 'running' ? [run] : []);
    const enqueued = [];
    eng.enqueueNode = async (_r, node, attempt) => { enqueued.push(`${node.id}#${attempt}`); };
    eng.failRun = async () => { throw new Error('failRun unerwartet'); };
    await eng.recoverInterruptedRuns();
    assert.deepEqual(enqueued, ['todo#2']);
    assert.equal(nodeRuns[1].status, 'interrupted');
  });

  await check('H-18: ohne fortsetzbaren Node scheitert der Run sichtbar statt neu zu starten', async () => {
    const runId = new Types.ObjectId();
    const run = { _id: runId, status: 'running', definitionSnapshot: graph, async save() {} };
    const eng = makeEngine({ nodeRuns: [{ _id: new Types.ObjectId(), runId, nodeId: 'trigger', status: 'succeeded', attempt: 1 }], runs: [run] });
    eng.runModel.find = (f) => exec(f.status === 'running' ? [run] : []);
    const enqueued = [];
    let failed = null;
    eng.enqueueNode = async (_r, node) => { enqueued.push(node.id); };
    eng.failRun = async (_r, err) => { failed = err.code; };
    await eng.recoverInterruptedRuns();
    assert.deepEqual(enqueued, []);
    assert.equal(failed, 'interrupted');
  });

  await check('M-14: zwei gleichzeitige Delay-Resumes setzen den Node EINMAL fort', async () => {
    const runId = new Types.ObjectId();
    const nr = { _id: new Types.ObjectId(), runId, nodeId: 'wait', status: 'waiting', waitingFor: { type: 'delay' }, attempt: 1 };
    const run = { _id: runId, status: 'waiting_for_timer', definitionSnapshot: graph, async save() {} };
    const eng = makeEngine({ nodeRuns: [nr], runs: [run] });
    let applied = 0;
    eng.applyResult = async () => { applied += 1; };
    await Promise.all([eng.resumeDelayedNode(nr._id), eng.resumeDelayedNode(nr._id)]);
    assert.equal(applied, 1, `Node ${applied}x fortgesetzt`);
  });

  await check('H-19: Job ohne Endpunkt endet nach Client-Abbruch statt ewig neu verzögert zu werden', async () => {
    const relay = new StreamRelay();
    const proc = Object.create(GatewayProcessor.prototype);
    proc.allocator = { acquire: async () => null };
    proc.relay = relay;
    let delayed = 0;
    const job = { id: 'j1', data: { purpose: 'chat' }, token: 't', timestamp: Date.now(), moveToDelayed: async () => { delayed += 1; } };
    const events = [];
    relay.subscribe('j1').subscribe((e) => events.push(e));
    relay.cancel('j1');
    await proc.process(job);
    assert.equal(delayed, 0);
    assert.equal(events.at(-1).type, 'error');
  });

  await check('H-19: Job ohne Endpunkt endet nach Ablauf der Wartezeit', async () => {
    const relay = new StreamRelay();
    const proc = Object.create(GatewayProcessor.prototype);
    proc.allocator = { acquire: async () => null };
    proc.relay = relay;
    let delayed = 0;
    const job = { id: 'j2', data: { purpose: 'chat' }, token: 't', timestamp: Date.now() - 10 * 60_000, moveToDelayed: async () => { delayed += 1; } };
    const events = [];
    relay.subscribe('j2').subscribe((e) => events.push(e));
    await proc.process(job);
    assert.equal(delayed, 0);
    assert.equal(events.at(-1).status, 503);
  });

  await check('M-12: Kontext-Updates überschreiben sich nicht (echte MongoDB, Ids mit . und $)', async () => {
    const uri = process.env.MONGODB_TEST_URI;
    if (!uri) { console.log('    (übersprungen: MONGODB_TEST_URI nicht gesetzt)'); return; }
    const { MongoClient } = require(path.resolve(__dirname, '..', 'node_modules', 'mongodb'));
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const coll = client.db().collection(`concurrency_check_${Date.now()}`);
    try {
      const { insertedId } = await coll.insertOne({ context: { nodes: { old: { v: 0 } }, input: { a: 1 } } });
      // Zwei „gleichzeitige" Pfade, jeder kennt nur seinen Node.
      await Promise.all([
        coll.updateOne({ _id: insertedId }, contextUpdatePipeline('n.1', { answer: '$danger' }, [{ edgeId: 'e$1', mapped: { x: 1 } }])),
        coll.updateOne({ _id: insertedId }, contextUpdatePipeline('n2', { resumedAt: 'now' }, [])),
      ]);
      const doc = await coll.findOne({ _id: insertedId });
      assert.deepEqual(doc.context.nodes.old, { v: 0 });
      assert.deepEqual(doc.context.nodes['n.1'], { answer: '$danger' });
      assert.deepEqual(doc.context.nodes.n2, { resumedAt: 'now' });
      assert.deepEqual(doc.context.fromEdges['e$1'], { x: 1 });
      assert.deepEqual(doc.context.input, { a: 1 });
      // Auch ein Dokument ganz ohne context.
      const { insertedId: id2 } = await coll.insertOne({});
      await coll.updateOne({ _id: id2 }, contextUpdatePipeline('a', { ok: true }, []));
      assert.deepEqual((await coll.findOne({ _id: id2 })).context.nodes.a, { ok: true });
    } finally {
      await coll.drop().catch(() => {});
      await client.close();
    }
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
