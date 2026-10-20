#!/usr/bin/env node
/*
 * Debug-Lauf Schritt für Schritt (Workflows debugbar machen, Task 6).
 *
 * Reiner Teil: `engine/debug-step` — Platzhalter-Ausgabe eines Trockenlaufs,
 * Fortschreiben der wartenden Nodes, entfernte Nodes, Wahl der
 * Trockenlauf-Strategie je Node-Art.
 *
 * Mongo-Teil (MONGODB_TEST_URI, Wegwerf-Datenbank; eigene Collections, werden
 * gelöscht): `startDebugRun` auf einem Draft, Schritte echt und trocken,
 * paralleler Schritt → 409, Wiederholen mit korrigierter Config, `hasOpenRun`
 * ignoriert Debug-Läufe, Leerlauf-Abbruch nach 30 min. Ohne die Variable wird
 * der Mongo-Teil übersprungen.
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

const debugStep = loadCompiled('workflows/engine/debug-step.js');

const EXPECTED_PURE = 6;
const EXPECTED_MONGO = 11;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

async function pureChecks() {
  const { dryPlaceholder, nextPending, dropMissing, dryStrategy, DEBUG_IDLE_MS, DEBUG_SKIP_TYPES } = debugStep;

  await check('Konstanten: 30 min Leerlauf, Delay-Typen', () => {
    assert.equal(DEBUG_IDLE_MS, 30 * 60_000);
    assert.deepEqual([...DEBUG_SKIP_TYPES], ['control.delay', 'delay.wait']);
  });

  await check('dryPlaceholder: dryRun + Ausgabe-Schlüssel mit null', () => {
    assert.deepEqual(dryPlaceholder({ exitCode: 'number', stdout: 'string' }), { dryRun: true, exitCode: null, stdout: null });
    assert.deepEqual(dryPlaceholder({}), { dryRun: true });
  });

  await check('nextPending: Schritt raus, Nachfolger hinten an', () => {
    assert.deepEqual(nextPending(['b', 'c'], 'b', ['d'], []), ['c', 'd']);
  });

  await check('nextPending: Wiederholung ersetzt die alten Nachfolger, dedupliziert', () => {
    assert.deepEqual(nextPending(['c', 'd'], 'b', ['e'], ['d']), ['c', 'e']);
    assert.deepEqual(nextPending(['c', 'd'], 'b', ['c', 'd', 'd'], []), ['c', 'd']);
  });

  await check('dropMissing: entfernte Nodes fallen raus und werden gemeldet', () => {
    assert.deepEqual(dropMissing(['a', 'x'], ['a']), { pending: ['a'], dropped: ['x'] });
  });

  await check('dryStrategy je Node-Art', () => {
    assert.equal(dryStrategy('control.delay', 'safe-read', 'control', false), 'skip_delay');
    assert.equal(dryStrategy('delay.wait', 'safe-read', 'control', true), 'skip_delay');
    assert.equal(dryStrategy('todo.find', 'safe-read', 'action', true), 'execute');
    assert.equal(dryStrategy('ssh.exec', 'external-call', 'action', true), 'ssh_preview');
    assert.equal(dryStrategy('agent.task', 'agent-write', 'agent', true), 'agent_dry');
    assert.equal(dryStrategy('action.todo-create', 'safe-write', 'action', true), 'placeholder');
    for (const [type, risk, cat] of [
      ['ssh.exec', 'external-call', 'action'],
      ['agent.task', 'agent-write', 'agent'],
      ['action.todo-create', 'safe-write', 'action'],
      ['todo.find', 'safe-read', 'action'],
    ]) {
      assert.equal(dryStrategy(type, risk, cat, false), 'execute', `${type} ohne dry`);
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mongoChecks(uri) {
  const { WorkflowEngineService } = loadCompiled('workflows/engine/workflow-engine.service.js');
  const { WorkflowsService } = loadCompiled('workflows/workflows.service.js');
  const { WorkflowSchedulerService } = loadCompiled('workflows/engine/workflow-scheduler.service.js');
  const { WorkflowQueueService } = loadCompiled('workflows/engine/workflow-queue.service.js');
  const { NodeRegistry } = loadCompiled('workflows/engine/node-registry.js');
  const { WORKFLOW_RUN_CANCELLED } = loadCompiled('workflows/engine/run-status.js');
  const { TriggerManualExecutor } = loadCompiled('workflows/nodes/trigger-manual.executor.js');
  const { ActionLogExecutor } = loadCompiled('workflows/nodes/action-log.executor.js');
  const { ActionTodoCreateExecutor } = loadCompiled('workflows/nodes/action-todo-create.executor.js');
  const { WorkflowRunSchema } = loadCompiled('workflows/schemas/workflow-run.schema.js');
  const { WorkflowNodeRunSchema } = loadCompiled('workflows/schemas/workflow-node-run.schema.js');
  const { WorkflowDefinitionSchema } = loadCompiled('workflows/schemas/workflow-definition.schema.js');
  const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));
  const { EventEmitter2 } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/event-emitter'));

  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  const suffix = `_debugcheck_${Date.now()}`;
  const Def = conn.model('WorkflowDefinition', WorkflowDefinitionSchema, `workflowdefinitions${suffix}`);
  const Run = conn.model('WorkflowRun', WorkflowRunSchema, `workflowruns${suffix}`);
  const NodeRun = conn.model('WorkflowNodeRun', WorkflowNodeRunSchema, `workflownoderuns${suffix}`);

  // Ein echtes todo-create mit Attrappe statt TodosService: jeder Aufruf
  // wäre ein Todo in der Datenbank.
  const createdTodos = [];
  const todos = { create: async (dto) => { createdTodos.push(dto); return { _id: new mongoose.Types.ObjectId(), number: 1 }; } };
  const registry = new NodeRegistry();
  registry.logger.warn = () => {};
  for (const ex of [new TriggerManualExecutor(), new ActionLogExecutor(), new ActionTodoCreateExecutor(todos)]) registry.register(ex);

  const emitter = new EventEmitter2();
  const queue = new WorkflowQueueService();
  const noop = { record: async () => {}, create: async () => {} };
  const secrets = { available: async () => [], resolve: async () => ({ values: {}, missing: [] }) };
  const engine = new WorkflowEngineService(
    Def, Run, NodeRun, queue, {}, registry, emitter, { create: async () => ({ _id: new mongoose.Types.ObjectId() }) },
    {}, noop, noop, { resolve: async () => null }, secrets,
  );
  const workflows = new WorkflowsService(Def, Run, NodeRun, emitter, registry, noop, secrets);
  const scheduler = new WorkflowSchedulerService(Def, workflows, noop);
  emitter.on(WORKFLOW_RUN_CANCELLED, (p) => engine.onRunCancelled(p));

  async function drain() {
    for (let i = 0; i < 20 && queue.size() > 0; i += 1) {
      const head = queue.peek();
      const job = queue.take(head.seq);
      if (job) await engine.runJob(job);
    }
  }

  const projectId = new mongoose.Types.ObjectId();
  const actor = { userId: '64b0000000000000000000aa', username: 'debugger', role: 'admin' };
  const other = { userId: '64b0000000000000000000bb', username: 'fremd', role: 'admin' };
  const pos = { x: 0, y: 0 };
  const graph = (logMessage = '{{input.msg}}') => ({
    nodes: [
      { id: 't', type: 'trigger.manual', position: pos, config: {} },
      { id: 'log', type: 'action.log', position: pos, config: { message: logMessage } },
      { id: 'todo', type: 'action.todo-create', position: pos, config: { title: '{{nodes.log.message}}' } },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'log' },
      { id: 'e2', source: 'log', target: 'todo' },
    ],
  });
  const step = (runId, nodeId, mode, g = graph(), who = actor) =>
    engine.debugStep(runId, { nodeId, mode, nodes: g.nodes, edges: g.edges }, who);
  // NodeRun-Abfragen mit ObjectId: ein String-`runId` traf hier nichts (die
  // Engine selbst fragt immer mit `run._id`).
  const oid = (id) => new mongoose.Types.ObjectId(id);
  const status = (e) => (typeof e?.getStatus === 'function' ? e.getStatus() : undefined);

  try {
    const def = await Def.create({
      scope: 'project', projectId, name: 'debug-check', status: 'draft', version: 1,
      trigger: { type: 'manual' }, nodes: [], edges: [],
    });
    const defId = def._id.toString();
    let runId;

    await check('startDebugRun auf Draft: waiting_for_step, pending [t]', async () => {
      const run = await workflows.startDebugRun(defId, { input: { msg: 'hallo' }, ...graph() }, actor);
      runId = run._id.toString();
      const fresh = await Run.findById(runId);
      assert.equal(fresh.mode, 'debug');
      assert.equal(fresh.status, 'waiting_for_step');
      assert.deepEqual([...fresh.debug.pendingNodeIds], ['t']);
      assert.deepEqual([...fresh.debug.notices], []);
      assert.equal(fresh.triggeredBy.userId, actor.userId);
      assert.deepEqual(fresh.context.input, { msg: 'hallo' });
      assert.equal(queue.size(), 0, 'Debug-Start reiht nichts ein');
    });

    await check('Schritt t ausführen: pending [log], context.nodes.t gesetzt; hasOpenRun ignoriert Debug', async () => {
      const res = await step(runId, 't', 'execute');
      assert.equal(res.status, 'running');
      assert.equal(await workflows.hasOpenRun(def._id), false, 'laufender Debug-Lauf zählt nicht');
      await drain();
      const fresh = await Run.findById(runId);
      assert.equal(fresh.status, 'waiting_for_step');
      assert.deepEqual([...fresh.debug.pendingNodeIds], ['log']);
      assert.deepEqual(fresh.context.nodes.t, {});
      assert.equal(await workflows.hasOpenRun(def._id), false, 'wartender Debug-Lauf zählt nicht');
    });

    await check('fremder Nutzer → 403, Node nicht wartend → 400', async () => {
      await assert.rejects(() => step(runId, 'log', 'execute', graph(), other), (e) => status(e) === 403);
      await assert.rejects(() => step(runId, 'todo', 'execute'), (e) => status(e) === 400);
      assert.equal((await Run.findById(runId)).status, 'waiting_for_step');
    });

    await check('zwei parallele Schritte: einer 409', async () => {
      const results = await Promise.allSettled([step(runId, 'log', 'execute'), step(runId, 'log', 'execute')]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.equal(ok.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(status(rejected[0].reason), 409);
      await drain();
      assert.equal(await NodeRun.countDocuments({ runId: oid(runId), nodeId: 'log' }), 1);
      const fresh = await Run.findById(runId);
      assert.deepEqual([...fresh.debug.pendingNodeIds], ['todo']);
      assert.equal(fresh.context.nodes.log.message, 'hallo');
    });

    await check('Schritt todo trocken: dryRun-NodeRun, kein Todo, Lauf succeeded', async () => {
      await step(runId, 'todo', 'dry');
      await drain();
      const nr = await NodeRun.findOne({ runId: oid(runId), nodeId: 'todo' });
      assert.equal(nr.status, 'succeeded');
      assert.equal(nr.dryRun, true);
      assert.equal(nr.outputSnapshot.dryRun, true);
      assert.ok('todoId' in nr.outputSnapshot);
      assert.equal(nr.nodeSnapshot.id, 'todo');
      assert.equal(nr.resolvedConfig.title, 'hallo', 'eingesetzte Config sichtbar');
      assert.equal(createdTodos.length, 0, 'Trockenlauf hat geschrieben');
      assert.equal((await Run.findById(runId)).status, 'succeeded');
    });

    let run2;
    await check('Schritt mit kaputter Config: NodeRun failed, Lauf bleibt waiting_for_step', async () => {
      run2 = (await workflows.startDebugRun(defId, { input: { msg: 'zwei' }, ...graph() }, actor))._id.toString();
      await step(run2, 't', 'execute');
      await drain();
      await step(run2, 'log', 'execute', graph('{{nodes.x.nope}}'));
      await drain();
      const nr = await NodeRun.findOne({ runId: oid(run2), nodeId: 'log' });
      assert.equal(nr.status, 'failed');
      assert.equal(nr.error.code, 'template_unresolved');
      assert.equal(nr.attempt, 1);
      const fresh = await Run.findById(run2);
      assert.equal(fresh.status, 'waiting_for_step');
      assert.equal(await NodeRun.countDocuments({ runId: oid(run2), nodeId: 'log' }), 1, 'kein Retry im Debug');
      assert.ok(fresh.debug.pendingNodeIds.includes('log'), 'gescheiterter Node bleibt dran');
    });

    await check('Wiederholung mit korrigierter Config: attempt 2 succeeded, Snapshot = DTO', async () => {
      await step(run2, 'log', 'execute', graph('fix {{input.msg}}'));
      await drain();
      const nr = await NodeRun.findOne({ runId: oid(run2), nodeId: 'log', attempt: 2 });
      assert.equal(nr.status, 'succeeded');
      assert.equal(nr.nodeSnapshot.config.message, 'fix {{input.msg}}');
      const fresh = await Run.findById(run2);
      assert.equal(fresh.status, 'waiting_for_step');
      assert.deepEqual([...fresh.debug.pendingNodeIds], ['todo']);
      assert.equal(fresh.context.nodes.log.message, 'fix zwei');
      assert.equal(fresh.definitionSnapshot.nodes.find((n) => n.id === 'log').config.message, 'fix {{input.msg}}');
    });

    await check('entfernter wartender Node: Hinweis, Lauf endet nach letztem Schritt', async () => {
      const g = graph();
      g.nodes = g.nodes.filter((n) => n.id !== 'todo');
      g.edges = g.edges.filter((e) => e.target !== 'todo');
      await step(run2, 'log', 'execute', g);
      await drain();
      const fresh = await Run.findById(run2);
      assert.ok(fresh.debug.notices.includes('Node todo wurde entfernt und übersprungen'), JSON.stringify(fresh.debug.notices));
      assert.equal(fresh.status, 'succeeded', 'nichts mehr offen, letzter Schritt ok');
    });

    await check('echter Schritt auf Trockenlauf-Werten: schreibender Node scheitert, nichts geschrieben', async () => {
      const r = (await workflows.startDebugRun(defId, { input: { msg: 'drei' }, ...graph() }, actor))._id.toString();
      await step(r, 't', 'execute');
      await drain();
      await step(r, 'log', 'dry');
      await drain();
      const log = await NodeRun.findOne({ runId: oid(r), nodeId: 'log' });
      assert.equal(log.dryRun, true);
      assert.equal(log.outputSnapshot.message, null);
      await step(r, 'todo', 'execute');
      await drain();
      const nr = await NodeRun.findOne({ runId: oid(r), nodeId: 'todo' });
      assert.equal(nr.status, 'failed');
      assert.equal(nr.error.code, 'template_unresolved');
      assert.match(nr.error.message, /nodes\.log\.message/);
      assert.equal(createdTodos.length, 0);
      assert.equal((await Run.findById(r)).status, 'waiting_for_step');
      // Trocken geht es weiter: der Platzhalter gilt als aufgelöst (Wert unbekannt).
      await step(r, 'todo', 'dry');
      await drain();
      const again = await NodeRun.findOne({ runId: oid(r), nodeId: 'todo', attempt: 2 });
      assert.equal(again.status, 'succeeded');
      assert.equal((await Run.findById(r)).status, 'succeeded');
    });

    await check('retryRun lehnt Debug-Läufe ab', async () => {
      const r = (await workflows.startDebugRun(defId, { ...graph() }, actor))._id.toString();
      await workflows.cancelRun(r, { reason: 'test' });
      await assert.rejects(() => engine.retryRun(r, undefined, actor), (e) => status(e) === 400);
    });

    await check('cancelIdleDebugRuns: 31 min ohne Schritt → cancelled, frischer bleibt', async () => {
      const idle = (await workflows.startDebugRun(defId, { ...graph() }, actor))._id.toString();
      const fresh = (await workflows.startDebugRun(defId, { ...graph() }, actor))._id.toString();
      await Run.updateOne({ _id: idle }, { $set: { 'debug.lastActivityAt': new Date(Date.now() - 31 * 60_000) } });
      await scheduler.cancelIdleDebugRuns();
      const a = await Run.findById(idle);
      assert.equal(a.status, 'cancelled');
      assert.equal(a.error.message, 'debug_idle');
      assert.equal((await Run.findById(fresh)).status, 'waiting_for_step');
    });
  } finally {
    await sleep(10);
    await Promise.all([Def, Run, NodeRun].map((m) => m.collection.drop().catch(() => {})));
    await conn.close();
  }
}

(async () => {
  await pureChecks();
  let expected = EXPECTED_PURE;
  const uri = process.env.MONGODB_TEST_URI;
  if (uri) {
    await mongoChecks(uri);
    expected += EXPECTED_MONGO;
  } else {
    console.log('(Mongo-Teil übersprungen: MONGODB_TEST_URI nicht gesetzt)');
  }
  console.log(`\n${total - failures}/${total} passed`);
  if (total !== expected) {
    console.error(`Erwartet ${expected} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
