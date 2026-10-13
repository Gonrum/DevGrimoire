#!/usr/bin/env node
/*
 * Workflow-Abbruch (Review-Fund M-20, 2026-10-13).
 *
 * `cancelRun` setzte nur den Run-Status. Wartende Jobs blieben in der Queue,
 * NodeRuns blieben für immer queued/running/waiting, ein laufender Executor
 * lief bis zum Timeout weiter — und wenn er fertig wurde, setzte die Engine
 * den abgebrochenen Run auf succeeded/failed zurück oder reihte Nachfolger
 * ein.
 *
 * Gegen eine echte MongoDB (MONGODB_TEST_URI, Wegwerf-Datenbank; der Check
 * legt eigene Collections an und löscht sie): die Engine arbeitet mit
 * Update-Pipelines und bedingten findOneAndUpdate, die eine Attrappe nicht
 * ehrlich nachbildet. Ohne die Variable wird der Check übersprungen — in CI
 * ist sie gesetzt.
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

const { WorkflowEngineService } = loadCompiled('workflows/engine/workflow-engine.service.js');
const { WorkflowsService } = loadCompiled('workflows/workflows.service.js');
const { WorkflowQueueService } = loadCompiled('workflows/engine/workflow-queue.service.js');
const { WORKFLOW_RUN_CANCELLED } = loadCompiled('workflows/engine/run-status.js');
const { WorkflowRunSchema } = loadCompiled('workflows/schemas/workflow-run.schema.js');
const { WorkflowNodeRunSchema } = loadCompiled('workflows/schemas/workflow-node-run.schema.js');
const { WorkflowDefinitionSchema } = loadCompiled('workflows/schemas/workflow-definition.schema.js');
const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));
const { EventEmitter2 } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/event-emitter'));

const EXPECTED_CHECKS = 5;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (await fn()) return;
  throw new Error(`Timeout: ${label}`);
}

(async () => {
  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    console.log('(übersprungen: MONGODB_TEST_URI nicht gesetzt)');
    process.exit(0);
  }
  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  const suffix = `_cancelcheck_${Date.now()}`;
  const Def = conn.model('WorkflowDefinition', WorkflowDefinitionSchema, `workflowdefinitions${suffix}`);
  const Run = conn.model('WorkflowRun', WorkflowRunSchema, `workflowruns${suffix}`);
  const NodeRun = conn.model('WorkflowNodeRun', WorkflowNodeRunSchema, `workflownoderuns${suffix}`);

  // Executor-Verhalten pro Test austauschbar.
  let executorImpl = async () => ({ status: 'success', output: {} });
  const registry = { get: () => ({ execute: (ctx) => executorImpl(ctx) }) };
  const emitter = new EventEmitter2();
  const queue = new WorkflowQueueService();
  const noop = { record: async () => {}, create: async () => {} };
  const engine = new WorkflowEngineService(Def, Run, NodeRun, queue, {}, registry, emitter, {}, {}, noop, noop);
  const workflows = new WorkflowsService(Def, Run, NodeRun, emitter, registry, noop);
  // @OnEvent wird ausserhalb von Nest nicht verdrahtet — von Hand.
  emitter.on(WORKFLOW_RUN_CANCELLED, (p) => engine.onRunCancelled(p));

  const node = (id) => ({ id, type: 'trigger.manual', config: {}, position: { x: 0, y: 0 } });
  async function newRun(nodes, edges = []) {
    return Run.create({
      definitionId: new mongoose.Types.ObjectId(), definitionVersion: 1, scope: 'system',
      definitionSnapshot: { nodes, edges }, trigger: { type: 'manual' }, status: 'running',
      startedAt: new Date(), context: { nodes: {} },
    });
  }
  async function enqueueAndTake(run, n) {
    await engine.enqueueNode(run, n, 1);
    const head = queue.peek();
    return queue.take(head.seq);
  }

  try {
    await check('laufender Knoten: Abbruch signalisiert, Run bleibt cancelled, kein Nachfolger', async () => {
      const run = await newRun([node('a'), node('b')], [{ id: 'e1', source: 'a', target: 'b' }]);
      let aborted = false;
      executorImpl = (ctx) => new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => { aborted = true; resolve({ status: 'success', output: {} }); });
      });
      const job = await enqueueAndTake(run, node('a'));
      const running = engine.runJob(job);
      await until(async () => (await NodeRun.findById(job.nodeRunId)).status === 'running', 'Knoten läuft');
      await workflows.cancelRun(run._id.toString(), { reason: 'test' });
      await running;
      assert.ok(aborted, 'Executor bekam kein Abort-Signal');
      assert.equal((await Run.findById(run._id)).status, 'cancelled');
      const nodeRuns = await NodeRun.find({ runId: run._id });
      assert.deepEqual(nodeRuns.map((n) => [n.nodeId, n.status]), [['a', 'interrupted']]);
      assert.equal(queue.size(), 0);
    });

    await check('wartender Job: fliegt aus der Queue, NodeRun interrupted, späteres runJob tut nichts', async () => {
      const run = await newRun([node('a')]);
      await engine.enqueueNode(run, node('a'), 1);
      const job = queue.peek();
      assert.equal(queue.size(), 1);
      let executed = false;
      executorImpl = async () => { executed = true; return { status: 'success', output: {} }; };
      await workflows.cancelRun(run._id.toString(), {});
      assert.equal(queue.size(), 0);
      const nr = await NodeRun.findOne({ runId: run._id });
      assert.equal(nr.status, 'interrupted');
      // Ein Worker, der den Job schon vor dem Abbruch genommen hatte:
      await engine.runJob(job);
      assert.equal(executed, false);
      assert.equal((await NodeRun.findById(nr._id)).status, 'interrupted');
    });

    await check('Fehlschlag nach Abbruch überschreibt cancelled nicht mit failed', async () => {
      const run = await newRun([node('a')]);
      let release;
      executorImpl = () => new Promise((resolve) => { release = () => resolve({ status: 'failed', error: { code: 'x', message: 'boom' } }); });
      const job = await enqueueAndTake(run, node('a'));
      const running = engine.runJob(job);
      await until(async () => (await NodeRun.findById(job.nodeRunId)).status === 'running', 'Knoten läuft');
      // Abbruch direkt in der DB, ohne Abort — simuliert einen Executor, der
      // das Signal ignoriert und danach mit einem Fehler zurückkommt.
      await Run.updateOne({ _id: run._id }, { $set: { status: 'cancelled' } });
      release();
      await running;
      const after = await Run.findById(run._id);
      assert.equal(after.status, 'cancelled');
      assert.equal(after.error, undefined);
      assert.equal(await NodeRun.countDocuments({ runId: run._id }), 1, 'Retry trotz Abbruch eingereiht');
    });

    await check('Erfolg des letzten Knotens nach Abbruch macht den Run nicht succeeded', async () => {
      const run = await newRun([node('a')]);
      let release;
      executorImpl = () => new Promise((resolve) => { release = () => resolve({ status: 'success', output: {} }); });
      const job = await enqueueAndTake(run, node('a'));
      const running = engine.runJob(job);
      await until(async () => (await NodeRun.findById(job.nodeRunId)).status === 'running', 'Knoten läuft');
      await Run.updateOne({ _id: run._id }, { $set: { status: 'cancelled' } });
      release();
      await running;
      assert.equal((await Run.findById(run._id)).status, 'cancelled');
    });

    await check('zweiter Abbruch -> 400, Status bleibt', async () => {
      const run = await newRun([node('a')]);
      await workflows.cancelRun(run._id.toString(), {});
      await assert.rejects(() => workflows.cancelRun(run._id.toString(), {}), (e) => e.getStatus?.() === 400);
      assert.equal((await Run.findById(run._id)).status, 'cancelled');
    });
  } finally {
    await Promise.all([Def, Run, NodeRun].map((m) => m.collection.drop().catch(() => {})));
    await conn.close();
  }

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
