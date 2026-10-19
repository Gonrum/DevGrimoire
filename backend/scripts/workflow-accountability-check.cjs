#!/usr/bin/env node
/**
 * Zurechenbarer Akteur pro Workflow-Lauf.
 *
 * Prüft gegen Attrappen (Auth, Definitions-Modell, WorkflowsService):
 *   - Auflösungsreihenfolge triggeredBy.userId → createdByUserId → letzte Approval
 *   - deaktivierte/fehlende Nutzer ergeben keinen Akteur
 *   - welche Risiko-Klassen einen Akteur verlangen
 *   - der Controller verwirft ein vom Client gesendetes `triggeredBy` und
 *     übergibt stattdessen den Request-Akteur
 *
 *   - die Engine verweigert Nodes mit Akteurpflicht ohne Akteur
 *
 * Läuft gegen `dist/`, ohne Nest. Mit MONGODB_TEST_URI (Wegwerf-Datenbank)
 * zusätzlich gegen die echte Engine: Ausführung im RequestContext des Akteurs
 * und Akteur des Retry-Laufs. Nach `npm run build` ausführen.
 */
const assert = require('node:assert/strict');

const { WorkflowAccountabilityService } = require('../dist/workflows/engine/workflow-accountability.service');
const { getWorkflowNodePolicy, requiresAccountableUser } = require('../dist/workflows/workflow-security.policy');
const { WorkflowsController } = require('../dist/workflows/workflows.controller');
const { RequestContext } = require('../dist/common/request-context');
const { accountabilityRefusal, WorkflowEngineService } = require('../dist/workflows/engine/workflow-engine.service');

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

const USER_A = '64b000000000000000000a0a';
const USER_B = '64b000000000000000000b0b';
const USER_C = '64b000000000000000000c0c';
const DEF_ID = '64b0000000000000000000de';

function oid(hex) {
  return { toString: () => hex };
}

function user(hex, active = true) {
  return { _id: oid(hex), username: `u-${hex.slice(-4)}`, role: 'user', active, permissions: [] };
}

/** AuthService-Attrappe: kennt nur die übergebenen Nutzer. */
function fakeAuth(users) {
  return {
    findUserById: async (id) => users.find((u) => u._id.toString() === id) ?? null,
  };
}

/** Definitions-Modell-Attrappe mit `findById(...).select(...).lean().exec()`. */
function fakeDefinitions(defs) {
  return {
    findById: (id) => {
      const doc = defs.find((d) => d._id.toString() === String(id)) ?? null;
      const q = { select: () => q, lean: () => q, exec: async () => doc };
      return q;
    },
  };
}

function service(users, defs = []) {
  return new WorkflowAccountabilityService(fakeDefinitions(defs), fakeAuth(users));
}

(async () => {
  await check('manueller Lauf: triggeredBy.userId eines aktiven Nutzers', async () => {
    const r = await service([user(USER_A)]).resolve({
      triggeredBy: { type: 'manual', userId: USER_A },
      definitionId: oid(DEF_ID),
    });
    assert.ok(r);
    assert.equal(r.userId, USER_A);
    assert.equal(r.actor.userId, USER_A);
  });

  await check('createdByUserId greift, wenn triggeredBy keinen Nutzer trägt', async () => {
    const r = await service([user(USER_C)]).resolve({
      triggeredBy: { type: 'manual' },
      createdByUserId: oid(USER_C),
      definitionId: oid(DEF_ID),
    });
    assert.equal(r && r.userId, USER_C);
  });

  await check('Zeitplan-Lauf ohne userId: letzte Approval (Nutzer B)', async () => {
    const def = {
      _id: oid(DEF_ID),
      approvals: [{ approvedByUserId: oid(USER_A) }, { approvedByUserId: oid(USER_B) }],
    };
    const r = await service([user(USER_A), user(USER_B)], [def]).resolve({
      triggeredBy: { type: 'schedule' },
      definitionId: oid(DEF_ID),
    });
    assert.equal(r && r.userId, USER_B);
  });

  await check('Zeitplan-Lauf: Nutzer B deaktiviert → null', async () => {
    const def = { _id: oid(DEF_ID), approvals: [{ approvedByUserId: oid(USER_B) }] };
    const r = await service([user(USER_B, false)], [def]).resolve({
      triggeredBy: { type: 'schedule' },
      definitionId: oid(DEF_ID),
    });
    assert.equal(r, null);
  });

  await check('Event-Lauf ohne Approval mit userId → null', async () => {
    const def = { _id: oid(DEF_ID), approvals: [{ approvedByUsername: 'legacy' }] };
    const r = await service([user(USER_A)], [def]).resolve({
      triggeredBy: { type: 'event' },
      definitionId: oid(DEF_ID),
    });
    assert.equal(r, null);
  });

  await check('manueller Lauf ohne Nutzer fällt NICHT auf die Approval zurück', async () => {
    const def = { _id: oid(DEF_ID), approvals: [{ approvedByUserId: oid(USER_B) }] };
    const r = await service([user(USER_B)], [def]).resolve({
      triggeredBy: { type: 'manual' },
      definitionId: oid(DEF_ID),
    });
    assert.equal(r, null);
  });

  await check('unbekannter / ungültiger userId → null', async () => {
    assert.equal(await service([]).resolve({ triggeredBy: { type: 'manual', userId: USER_A }, definitionId: oid(DEF_ID) }), null);
    assert.equal(await service([user(USER_A)]).resolve({ triggeredBy: { type: 'manual', userId: 'kein-oid' }, definitionId: oid(DEF_ID) }), null);
  });

  await check('requiresAccountableUser', async () => {
    assert.equal(requiresAccountableUser('external-call'), true);
    assert.equal(requiresAccountableUser('workspace-git'), true);
    assert.equal(requiresAccountableUser('safe-write'), false);
    assert.equal(requiresAccountableUser('safe-read'), false);
  });

  await check('Controller.startRun verwirft triggeredBy und übergibt den Request-Akteur', async () => {
    const calls = [];
    const workflows = { startRun: async (dto, userId) => { calls.push({ dto, userId }); return { ok: true }; } };
    const controller = new WorkflowsController(workflows, {}, {});
    const actor = { userId: USER_A, username: 'a', role: 'user' };
    await RequestContext.run(actor, undefined, () =>
      controller.startRun({ definitionId: DEF_ID, input: { x: 1 }, triggeredBy: { type: 'schedule', userId: USER_B } }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dto.triggeredBy, undefined);
    assert.equal('triggeredBy' in calls[0].dto, false);
    assert.equal(calls[0].dto.definitionId, DEF_ID);
    assert.deepEqual(calls[0].dto.input, { x: 1 });
    assert.equal(calls[0].userId, USER_A);
  });

  await check('Controller.retryRun reicht den Request-Akteur an die Engine', async () => {
    const calls = [];
    const engine = { retryRun: async (...args) => { calls.push(args); return { _id: oid('child') }; } };
    const controller = new WorkflowsController({}, engine, {});
    await RequestContext.run({ userId: USER_C, username: 'c', role: 'user' }, undefined, () =>
      controller.retryRun('parent', { fromNodeId: 'n2' }),
    );
    assert.deepEqual(calls[0], ['parent', 'n2', USER_C]);
  });

  await check('Engine-Gate: external-call ohne Akteur → no_accountable_user', async () => {
    const r = accountabilityRefusal('http.request', false);
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'no_accountable_user');
    assert.equal(accountabilityRefusal('workspace.exec', false).error.code, 'no_accountable_user');
    assert.equal(accountabilityRefusal('ssh.exec', false).error.code, 'no_accountable_user');
    assert.equal(requiresAccountableUser(getWorkflowNodePolicy('ssh.exec').risk), true);
  });

  await check('Engine-Gate: mit Akteur oder ohne Akteurpflicht kein Eingriff', async () => {
    assert.equal(accountabilityRefusal('http.request', true), undefined);
    assert.equal(accountabilityRefusal('action.log', false), undefined);
    assert.equal(accountabilityRefusal('gibt.es.nicht', false), undefined);
  });

  await engineChecks();

  console.log(`${passed} passed`);
})();

/** Gegen die echte Engine — braucht eine MongoDB (Update-Pipelines). */
async function engineChecks() {
  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    console.log('(Engine-Checks übersprungen: MONGODB_TEST_URI nicht gesetzt)');
    return;
  }
  const path = require('node:path');
  const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));
  const { EventEmitter2 } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/event-emitter'));
  // Queue-Debug-Zeilen würden die Ausgabe zuschütten.
  require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/common')).Logger.overrideLogger(['error', 'warn']);
  const { WorkflowQueueService } = require('../dist/workflows/engine/workflow-queue.service');
  const { WorkflowRunSchema } = require('../dist/workflows/schemas/workflow-run.schema');
  const { WorkflowNodeRunSchema } = require('../dist/workflows/schemas/workflow-node-run.schema');
  const { WorkflowDefinitionSchema } = require('../dist/workflows/schemas/workflow-definition.schema');

  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  const suffix = `_acccheck_${Date.now()}`;
  const Def = conn.model('WorkflowDefinition', WorkflowDefinitionSchema, `workflowdefinitions${suffix}`);
  const Run = conn.model('WorkflowRun', WorkflowRunSchema, `workflowruns${suffix}`);
  const NodeRun = conn.model('WorkflowNodeRun', WorkflowNodeRunSchema, `workflownoderuns${suffix}`);

  let seen = null;
  const executions = [];
  const registry = {
    get: () => ({
      execute: async (ctx) => {
        executions.push(ctx.node.id);
        seen = { accountableUserId: ctx.accountableUserId, contextUser: RequestContext.getUser()?.userId };
        // `config.fail` lässt einen Node mit diesem Fehlercode scheitern.
        if (ctx.config && ctx.config.fail) return { status: 'failed', error: { code: ctx.config.fail, message: 'x' } };
        return { status: 'success', output: {} };
      },
    }),
  };
  const queue = new WorkflowQueueService();
  const noop = { record: async () => {}, create: async () => {} };
  const accountability = new WorkflowAccountabilityService(Def, fakeAuth([user(USER_A)]));
  const engine = new WorkflowEngineService(
    Def, Run, NodeRun, queue, {}, registry, new EventEmitter2(), noop, {}, noop, noop, accountability,
  );
  const node = { id: 'a', type: 'action.log', config: {}, position: { x: 0, y: 0 } };
  const newRun = (extra) => Run.create({
    definitionId: new mongoose.Types.ObjectId(), definitionVersion: 1, scope: 'system',
    definitionSnapshot: { nodes: [node], edges: [] }, trigger: { type: 'manual' }, status: 'running',
    startedAt: new Date(), context: { nodes: {} }, ...extra,
  });
  async function runNode(run) {
    await engine.enqueueNode(run, node, 1);
    const job = queue.take(queue.peek().seq);
    await engine.runJob(job);
  }

  try {
    await check('Engine: Node läuft im RequestContext des Akteurs', async () => {
      seen = null;
      await runNode(await newRun({ triggeredBy: { type: 'manual', userId: USER_A } }));
      assert.deepEqual(seen, { accountableUserId: USER_A, contextUser: USER_A });
    });

    await check('Engine: ohne Akteur läuft ein Node ohne Akteurpflicht wie bisher', async () => {
      seen = null;
      await runNode(await newRun({ triggeredBy: { type: 'manual' } }));
      assert.deepEqual(seen, { accountableUserId: undefined, contextUser: undefined });
    });

    await check('Engine: Retry trägt den auslösenden Nutzer, sonst den des Elternlaufs', async () => {
      const p1 = await newRun({ status: 'failed', triggeredBy: { type: 'manual', userId: USER_A } });
      const c1 = await engine.retryRun(p1._id.toString(), 'a', USER_C);
      assert.equal(c1.triggeredBy.userId, USER_C);
      assert.equal(c1.triggeredBy.type, 'manual');
      const p2 = await newRun({ status: 'failed', triggeredBy: { type: 'manual', userId: USER_A } });
      const c2 = await engine.retryRun(p2._id.toString(), 'a');
      assert.equal(c2.triggeredBy.userId, USER_A);
    });

    await check('Engine: ssh.exec ohne Akteur → no_accountable_user, Lauf folgt der failure-Edge', async () => {
      seen = null;
      const ssh = { id: 'ssh', type: 'ssh.exec', config: { connectionId: 'x', command: 'true' }, position: { x: 0, y: 0 } };
      const alarm = { id: 'alarm', type: 'action.log', config: {}, position: { x: 0, y: 0 } };
      const run = await Run.create({
        definitionId: new mongoose.Types.ObjectId(), definitionVersion: 1, scope: 'project',
        projectId: new mongoose.Types.ObjectId(),
        definitionSnapshot: {
          nodes: [ssh, alarm],
          edges: [{ id: 'e1', source: 'ssh', target: 'alarm', branch: 'failure' }],
        },
        trigger: { type: 'manual' }, status: 'running', triggeredBy: { type: 'manual' },
        startedAt: new Date(), context: { nodes: {} },
      });
      // Reste früherer Checks (Retry-Läufe) abräumen, damit peek() den ssh-Job liefert.
      for (let j = queue.peek(); j; j = queue.peek()) queue.take(j.seq);
      await engine.enqueueNode(run, ssh, 1);
      const job = queue.take(queue.peek().seq);
      await engine.runJob(job);
      assert.equal(seen, null, 'Executor darf ohne Akteur nicht laufen');
      const nr = await NodeRun.findOne({ runId: run._id, nodeId: 'ssh' }).lean();
      assert.equal(nr.status, 'failed');
      assert.equal(nr.error.code, 'no_accountable_user');
      const next = queue.peek();
      assert.ok(next, 'failure-Edge muss den Folge-Node einreihen');
      assert.equal(next.nodeId, 'alarm');
      const after = await Run.findById(run._id).lean();
      assert.equal(after.context.nodes.ssh.error.code, 'no_accountable_user');
      assert.notEqual(after.status, 'failed');
      queue.take(next.seq);
    });

    await check('Engine: Fehlerpfad folgt nur failure-Edges, nicht unbeschrifteten (Final-Review I1)', async () => {
      const step1 = { id: 'step1', type: 'action.log', config: { fail: 'nonzero_exit' }, position: { x: 0, y: 0 } };
      const step2 = { id: 'step2', type: 'action.log', config: {}, position: { x: 0, y: 0 } };
      const alarm = { id: 'alarm', type: 'action.log', config: {}, position: { x: 0, y: 0 } };
      const run = await newRun({
        triggeredBy: { type: 'manual', userId: USER_A },
        definitionSnapshot: {
          nodes: [step1, step2, alarm],
          edges: [
            { id: 'e1', source: 'step1', target: 'step2' },
            { id: 'e2', source: 'step1', target: 'alarm', branch: 'failure' },
          ],
        },
      });
      for (let j = queue.peek(); j; j = queue.peek()) queue.take(j.seq);
      await engine.enqueueNode(run, step1, 1);
      await engine.runJob(queue.take(queue.peek().seq));
      const queued = [];
      for (let j = queue.peek(); j; j = queue.peek()) queued.push(queue.take(j.seq).nodeId);
      assert.deepEqual(queued, ['alarm']);
    });
  } finally {
    await Promise.all([Def, Run, NodeRun].map((m) => m.collection.drop().catch(() => {})));
    await conn.close();
  }
}
