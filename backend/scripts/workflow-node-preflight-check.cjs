#!/usr/bin/env node
/**
 * Engine-Vorprüfung: Platzhalter werden vor jedem executor.execute aufgelöst.
 *
 * Reine Funktionen (preflightNode, capSnapshot, inputView) laufen ohne Mongo.
 * Mit MONGODB_TEST_URI (Wegwerf-Datenbank) zusätzlich gegen die echte Engine:
 * fehlender Pfad -> template_unresolved ohne execute, Fehlerzweig, Bekommen/
 * Eingesetzt im NodeRun. Nach `npm run build` ausführen.
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const { preflightNode, redactPlaceholders } = require('../dist/workflows/engine/node-preflight');
const { capSnapshot, inputView } = require('../dist/workflows/engine/snapshot-cap');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

(async () => {
  await check('fehlender Pfad -> template_unresolved mit Ausdruck in der Meldung', async () => {
    const r = preflightNode({ title: '{{error.message}}' }, { nodes: {} }, { secretsAllowed: false, nodeType: 'action.todo-create' });
    assert.equal(r.failure.status, 'failed');
    assert.equal(r.failure.error.code, 'template_unresolved');
    assert.ok(r.failure.error.message.includes('error.message'));
    assert.equal(r.resolved.placeholders[0].status, 'missing');
  });

  await check('vorhandener Pfad -> kein failure', async () => {
    const r = preflightNode({ title: '{{nodes.a.x}}' }, { nodes: { a: { x: 'ok' } } }, { secretsAllowed: false, nodeType: 'action.log' });
    assert.equal(r.failure, undefined);
    assert.equal(r.resolved.value.title, 'ok');
  });

  await check('Secret bei secretsAllowed:false -> secret_not_allowed (hat Vorrang)', async () => {
    const r = preflightNode({ c: '{{secrets.T}} {{nodes.x.y}}' }, { nodes: {} }, { secretsAllowed: false, nodeType: 'action.log' });
    assert.equal(r.failure.error.code, 'secret_not_allowed');
    assert.ok(r.failure.error.message.includes('action.log'));
    assert.ok(r.failure.error.message.includes('T'));
  });

  await check('capSnapshot kappt große Snapshots, lässt kleine durch', async () => {
    const big = capSnapshot({ s: 'x'.repeat(30_000) });
    assert.equal(big.truncated, true);
    assert.equal(big.preview.length, 20_000);
    const small = { a: 1 };
    assert.deepEqual(capSnapshot(small), small);
  });

  await check('inputView hat genau input, incoming, nodes', async () => {
    const v = inputView({ input: { a: 1 }, incoming: { b: 2 }, nodes: { c: 3 }, fromEdges: { z: 1 } });
    assert.deepEqual(Object.keys(v).sort(), ['incoming', 'input', 'nodes']);
  });

  await check('redactPlaceholders maskiert Authorization-Feld und KV-Muster im preview', async () => {
    const r = preflightNode(
      { headers: { Authorization: 'Bearer {{nodes.l.v}}' }, note: 'x {{nodes.l.kv}}' },
      { nodes: { l: { v: 'PLAINTOKEN123', kv: 'password=hunter2xyz' } } },
      { secretsAllowed: false, nodeType: 'action.log' },
    );
    const json = JSON.stringify(redactPlaceholders(r.resolved.placeholders));
    assert.ok(!json.includes('PLAINTOKEN123'), json);
    assert.ok(!json.includes('hunter2xyz'), json);
  });

  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    console.log('(Engine-Checks übersprungen: MONGODB_TEST_URI nicht gesetzt)');
    return;
  }
  const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));
  const { EventEmitter2 } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/event-emitter'));
  require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/common')).Logger.overrideLogger(['error', 'warn']);
  const { WorkflowEngineService } = require('../dist/workflows/engine/workflow-engine.service');
  const { WorkflowQueueService } = require('../dist/workflows/engine/workflow-queue.service');
  const { WorkflowRunSchema } = require('../dist/workflows/schemas/workflow-run.schema');
  const { WorkflowNodeRunSchema } = require('../dist/workflows/schemas/workflow-node-run.schema');
  const { WorkflowDefinitionSchema } = require('../dist/workflows/schemas/workflow-definition.schema');

  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  const suffix = `_pfcheck_${Date.now()}`;
  const Def = conn.model('WorkflowDefinition', WorkflowDefinitionSchema, `workflowdefinitions${suffix}`);
  const Run = conn.model('WorkflowRun', WorkflowRunSchema, `workflowruns${suffix}`);
  const NodeRun = conn.model('WorkflowNodeRun', WorkflowNodeRunSchema, `workflownoderuns${suffix}`);

  const executions = [];
  const registry = {
    get: () => ({
      execute: async (ctx) => {
        executions.push(ctx.node.id);
        return { status: 'success', output: {} };
      },
    }),
  };
  const queue = new WorkflowQueueService();
  const noop = { record: async () => {}, create: async () => {} };
  const accountability = { resolve: async () => null };
  const engine = new WorkflowEngineService(
    Def, Run, NodeRun, queue, {}, registry, new EventEmitter2(), noop, {}, noop, noop, accountability,
  );
  const pos = { x: 0, y: 0 };
  const log = { id: 'log', type: 'action.log', config: { message: '{{nodes.t.nope}}' }, position: pos };
  const handler = { id: 'handler', type: 'action.log', config: { message: 'fehler' }, position: pos };
  const newRun = (edges) => Run.create({
    definitionId: new mongoose.Types.ObjectId(), definitionVersion: 1, scope: 'system',
    definitionSnapshot: { nodes: [log, handler], edges }, trigger: { type: 'manual' }, status: 'running',
    startedAt: new Date(), context: { nodes: { t: { ok: true } } },
  });
  async function runNext() {
    await engine.runJob(queue.take(queue.peek().seq));
  }

  try {
    await check('Engine: fehlender Pfad -> NodeRun failed, kein execute, Bekommen/Eingesetzt gespeichert', async () => {
      executions.length = 0;
      const run = await newRun([]);
      for (let j = queue.peek(); j; j = queue.peek()) queue.take(j.seq);
      await engine.enqueueNode(run, log, 1);
      await runNext();
      const nr = await NodeRun.findOne({ runId: run._id, nodeId: 'log' }).lean();
      assert.equal(nr.status, 'failed');
      assert.equal(nr.error.code, 'template_unresolved');
      assert.equal(nr.placeholders[0].status, 'missing');
      assert.ok(nr.inputSnapshot.nodes, 'inputSnapshot.nodes vorhanden');
      assert.ok(nr.resolvedConfig, 'resolvedConfig vorhanden');
      assert.deepEqual(executions, []);
      assert.ok(!queue.peek(), 'kein Retry');
      assert.equal((await Run.findById(run._id).lean()).status, 'failed');
    });

    await check('Engine: failure-Kante fängt template_unresolved, Lauf endet succeeded', async () => {
      executions.length = 0;
      const run = await newRun([{ id: 'e1', source: 'log', target: 'handler', branch: 'failure' }]);
      for (let j = queue.peek(); j; j = queue.peek()) queue.take(j.seq);
      await engine.enqueueNode(run, log, 1);
      await runNext();
      await runNext();
      assert.deepEqual(executions, ['handler']);
      assert.equal((await Run.findById(run._id).lean()).status, 'succeeded');
    });

    await check('Engine: Authorization-Platzhalter und großer Kontext im NodeRun', async () => {
      let deep = 'DEEPVALUE';
      for (let i = 0; i < 8; i += 1) deep = { n: deep };
      const n = { id: 'big', type: 'action.log', config: { headers: { Authorization: 'Bearer {{nodes.t.tok}}' }, m: '{{nodes.t.kv}}' }, position: pos };
      const run = await Run.create({
        definitionId: new mongoose.Types.ObjectId(), definitionVersion: 1, scope: 'system',
        definitionSnapshot: { nodes: [n], edges: [] }, trigger: { type: 'manual' }, status: 'running',
        startedAt: new Date(),
        context: { nodes: { t: { tok: 'PLAINTOKEN123', kv: 'password=hunter2xyz', big: 'y'.repeat(3000), big2: 'z'.repeat(3000), deep } } },
      });
      for (let j = queue.peek(); j; j = queue.peek()) queue.take(j.seq);
      await engine.enqueueNode(run, n, 1);
      await runNext();
      const nr = await NodeRun.findOne({ runId: run._id, nodeId: 'big' }).lean();
      const ph = JSON.stringify(nr.placeholders);
      assert.ok(!ph.includes('PLAINTOKEN123') && !ph.includes('hunter2xyz'), ph);
      assert.equal(typeof nr.inputSnapshot.nodes, 'object');
      assert.equal(nr.inputSnapshot.truncated, undefined);
      assert.equal(nr.inputSnapshot.nodes.t.big.length, 3000);
      assert.equal(nr.inputSnapshot.nodes.t.deep.n.n.n.n.n.n.n.n, 'DEEPVALUE');
    });

    await check('Engine: erfolgreicher Node speichert eingesetzte Config', async () => {
      const ok = { id: 'ok', type: 'action.log', config: { message: 'hi {{nodes.t.ok}}' }, position: pos };
      const run = await Run.create({
        definitionId: new mongoose.Types.ObjectId(), definitionVersion: 1, scope: 'system',
        definitionSnapshot: { nodes: [ok], edges: [] }, trigger: { type: 'manual' }, status: 'running',
        startedAt: new Date(), context: { nodes: { t: { ok: true } } },
      });
      for (let j = queue.peek(); j; j = queue.peek()) queue.take(j.seq);
      await engine.enqueueNode(run, ok, 1);
      await runNext();
      const nr = await NodeRun.findOne({ runId: run._id, nodeId: 'ok' }).lean();
      assert.equal(nr.status, 'succeeded');
      assert.equal(nr.resolvedConfig.message, 'hi true');
      assert.equal(nr.placeholders[0].status, 'resolved');
    });
  } finally {
    await Promise.all([Def, Run, NodeRun].map((m) => m.collection.drop().catch(() => {})));
    await conn.close();
  }
})().then(() => console.log(`${passed} Checks bestanden`));
