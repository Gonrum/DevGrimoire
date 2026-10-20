#!/usr/bin/env node
/**
 * `{{secrets.KEY}}` in Workflows: nur `ssh.exec` bekommt den echten Wert,
 * überall sonst `secret_not_allowed`, und der Klartext landet nirgends im
 * gespeicherten Lauf.
 *
 * Reine Teile (WorkflowSecretsResolver gegen Attrappen, secretPlaceholderIssues,
 * summarizeRisk) laufen ohne Mongo. Mit MONGODB_TEST_URI (Wegwerf-Datenbank)
 * zusätzlich gegen die echte Engine mit echtem Secret-Modell und einer
 * SSH-Attrappe, die den gesendeten Befehl als stdout zurückgibt.
 * Nach `npm run build` ausführen.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { Types } = require('mongoose');
const { ForbiddenException } = require('@nestjs/common');

const { WorkflowSecretsResolver, secretPlaceholderIssues } = require('../dist/workflows/engine/workflow-secrets.resolver');
const { summarizeRisk } = require('../dist/workflows/workflow-security.runtime');
const { RequestContext } = require('../dist/common/request-context');
const { toPublicMetadata } = require('../dist/workflows/engine/node-metadata');
const { SshExecExecutor } = require('../dist/workflows/nodes/ssh-exec.executor');

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

const PROJ = new Types.ObjectId();
const CUST = new Types.ObjectId();
const ACTOR = { userId: new Types.ObjectId().toString(), actor: { userId: 'u1', username: 'u', role: 'user' } };

/** Secret-Modell-Attrappe: merkt sich die Filter, liefert feste Dokumente. */
function fakeSecretModel(docs) {
  const filters = [];
  return {
    filters,
    find(filter) {
      filters.push(filter);
      const q = { lean: () => q, exec: async () => docs };
      return q;
    },
  };
}

function fakeScope(owners) {
  return { allowedOwners: async () => owners };
}

function doc(key, owner, extra = {}) {
  return { _id: new Types.ObjectId(), key, description: `d-${key}`, ...owner, ...extra };
}

(async () => {
  await check('available: Projekt gewinnt bei gleichem KEY, Kunden-Secret mit origin customer', async () => {
    const pT = doc('T', { projectId: PROJ });
    const cT = doc('T', { customerId: CUST });
    const cK = doc('K', { customerId: CUST });
    const model = fakeSecretModel([cT, cK, pT]);
    const r = new WorkflowSecretsResolver(model, {}, fakeScope({ projectIds: [PROJ.toString()], customerIds: [CUST.toString()] }));
    const list = await r.available({ projectId: PROJ.toString() });
    const t = list.filter((s) => s.key === 'T');
    assert.equal(t.length, 1);
    assert.equal(t[0].origin, 'project');
    assert.equal(t[0].ownerId, PROJ.toString());
    const k = list.find((s) => s.key === 'K');
    assert.equal(k.origin, 'customer');
    assert.equal(k.ownerId, CUST.toString());
    assert.ok(!JSON.stringify(list).includes('encryptedValue'), 'nie Werte/Chiffrat');
  });

  await check('available: Filter mit environmentId:null und beiden $exists:false', async () => {
    const model = fakeSecretModel([]);
    const r = new WorkflowSecretsResolver(model, {}, fakeScope({ projectIds: [PROJ.toString()], customerIds: [CUST.toString()] }));
    await r.available({ projectId: PROJ.toString() });
    const f = model.filters[0];
    assert.equal(f.environmentId, null);
    assert.ok('environmentId' in f);
    assert.deepEqual(f.ownedBySshConnectionId, { $exists: false });
    assert.deepEqual(f.ownedByKubeClusterId, { $exists: false });
    assert.ok(f.$or[0].projectId.$in[0] instanceof Types.ObjectId);
    assert.ok(f.$or[1].customerId.$in[0] instanceof Types.ObjectId);
  });

  await check('available/resolve: leere Owner-Listen → kein find', async () => {
    const model = fakeSecretModel([doc('T', { projectId: PROJ })]);
    const r = new WorkflowSecretsResolver(model, {}, fakeScope({ projectIds: [], customerIds: [] }));
    assert.deepEqual(await r.available({}), []);
    const res = await r.resolve({}, ['T'], ACTOR);
    assert.deepEqual(res, { values: {}, missing: ['T'] });
    assert.equal(model.filters.length, 0);
  });

  await check('available: ungültige IDs gehen nicht in den Filter', async () => {
    const model = fakeSecretModel([]);
    const r = new WorkflowSecretsResolver(model, {}, fakeScope({ projectIds: ['kaputt'], customerIds: [] }));
    assert.deepEqual(await r.available({ projectId: PROJ.toString() }), []);
    assert.equal(model.filters.length, 0);
  });

  await check('resolve: mit Akteur → Wert, im RequestContext des Akteurs gelesen', async () => {
    const pT = doc('T', { projectId: PROJ });
    const model = fakeSecretModel([pT]);
    let seenUser;
    const secrets = { findById: async (id) => { seenUser = RequestContext.getUser(); assert.equal(id, pT._id.toString()); return { value: 'geheim123' }; } };
    const r = new WorkflowSecretsResolver(model, secrets, fakeScope({ projectIds: [PROJ.toString()], customerIds: [] }));
    const res = await r.resolve({ projectId: PROJ }, ['T'], ACTOR);
    assert.equal(res.values.T, 'geheim123');
    assert.deepEqual(res.missing, []);
    assert.equal(seenUser.userId, 'u1');
    assert.deepEqual(model.filters[0].key, { $in: ['T'] });
  });

  await check('resolve: ForbiddenException → missing', async () => {
    const model = fakeSecretModel([doc('T', { projectId: PROJ })]);
    const secrets = { findById: async () => { throw new ForbiddenException('nope'); } };
    const r = new WorkflowSecretsResolver(model, secrets, fakeScope({ projectIds: [PROJ.toString()], customerIds: [] }));
    const res = await r.resolve({ projectId: PROJ }, ['T'], ACTOR);
    assert.deepEqual(res, { values: {}, missing: ['T'] });
  });

  await check('resolve: Akteur null → missing, findById nie aufgerufen', async () => {
    const model = fakeSecretModel([doc('T', { projectId: PROJ })]);
    const secrets = { findById: async () => assert.fail('ohne Akteur nie lesen') };
    const r = new WorkflowSecretsResolver(model, secrets, fakeScope({ projectIds: [PROJ.toString()], customerIds: [] }));
    const res = await r.resolve({ projectId: PROJ }, ['T'], null);
    assert.deepEqual(res, { values: {}, missing: ['T'] });
  });

  await check('secretPlaceholderIssues: action.notify mit Secret → Meldung, ssh.exec → keine', async () => {
    const issues = secretPlaceholderIssues([{ id: 'n', type: 'action.notify', config: { body: '{{secrets.T}}' } }], (t) => t === 'ssh.exec');
    assert.equal(issues.length, 1);
    assert.ok(issues[0].includes('n') && issues[0].includes('T'), issues[0]);
    assert.equal(issues[0], 'node "n" (action.notify): Secrets sind hier nicht erlaubt (T)');
    assert.deepEqual(secretPlaceholderIssues([{ id: 's', type: 'ssh.exec', config: { command: '{{secrets.T}}' } }], (t) => t === 'ssh.exec'), []);
  });

  await check('summarizeRisk liefert sortierte secretKeys', async () => {
    const r = summarizeRisk([{ type: 'ssh.exec', config: { command: '{{secrets.B}} {{secrets.A}}' } }]);
    assert.deepEqual(r.secretKeys, ['A', 'B']);
    assert.deepEqual(summarizeRisk([{ type: 'action.log' }]).secretKeys, []);
  });

  await check('Metadata: ssh.exec secretPlaceholders true, Public-Default false', async () => {
    const ssh = new SshExecExecutor({}, {}, {}, {});
    assert.equal(ssh.metadata.secretPlaceholders, true);
    assert.equal(toPublicMetadata(ssh.metadata).secretPlaceholders, true);
    const { z } = require('zod');
    const pub = toPublicMetadata({ type: 'x', category: 'action', label: 'x', description: '', allowedScopes: [], configSchema: z.object({}), outputs: {} });
    assert.equal(pub.secretPlaceholders, false);
  });

  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    console.log('(Engine-Checks übersprungen: MONGODB_TEST_URI nicht gesetzt)');
    return;
  }
  // Eigener Schlüssel nur für diesen Prozess — die Test-Secrets werden damit
  // ver- und entschlüsselt, die echte Instanz bleibt unberührt.
  process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));
  const { EventEmitter2 } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/event-emitter'));
  require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/common')).Logger.overrideLogger(['error', 'warn']);
  const { WorkflowEngineService } = require('../dist/workflows/engine/workflow-engine.service');
  const { WorkflowQueueService } = require('../dist/workflows/engine/workflow-queue.service');
  const { WorkflowRunSchema } = require('../dist/workflows/schemas/workflow-run.schema');
  const { WorkflowNodeRunSchema } = require('../dist/workflows/schemas/workflow-node-run.schema');
  const { WorkflowDefinitionSchema } = require('../dist/workflows/schemas/workflow-definition.schema');
  const { SecretSchema } = require('../dist/secrets/schemas/secret.schema');
  const { SecretsService } = require('../dist/secrets/secrets.service');
  const { EncryptionService } = require('../dist/common/encryption.service');

  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  const suffix = `_seccheck_${Date.now()}`;
  const Def = conn.model('WorkflowDefinition', WorkflowDefinitionSchema, `workflowdefinitions${suffix}`);
  const Run = conn.model('WorkflowRun', WorkflowRunSchema, `workflowruns${suffix}`);
  const NodeRun = conn.model('WorkflowNodeRun', WorkflowNodeRunSchema, `workflownoderuns${suffix}`);
  const Secret = conn.model('Secret', SecretSchema, `secrets${suffix}`);

  const encryption = new EncryptionService();
  const secretsService = new SecretsService(Secret, {}, encryption, new EventEmitter2());
  const project = new mongoose.Types.ObjectId();
  await Secret.create({ projectId: project, key: 'T', encryptedValue: encryption.encrypt('geheim123'), description: 'Token' });
  // Gleicher KEY, aber an eine Umgebung gebunden → nie Workflow-Secret.
  await Secret.create({ projectId: project, environmentId: 'prod', key: 'T', encryptedValue: encryption.encrypt('falsch-env'), description: '' });

  const scope = {
    allowedOwners: async () => ({ projectIds: [project.toString()], customerIds: [] }),
    check: async () => true,
  };
  const resolver = new WorkflowSecretsResolver(Secret, secretsService, scope);
  const sent = [];
  const session = {
    async exec(connId, command) {
      sent.push(command);
      return {
        stdout: command, stderr: '', exitCode: 0, durationMs: 1,
        truncated: { stdout: false, stderr: false }, stdoutBytes: command.length, stderrBytes: 0, lastChunkAgeMs: 0,
      };
    },
  };
  const ssh = { findById: async () => ({ _id: new mongoose.Types.ObjectId(), label: 'web', projectId: project }) };
  const sshExec = new SshExecExecutor(ssh, session, {}, scope);
  let notifyRan = false;
  const notify = {
    type: 'action.notify',
    metadata: { type: 'action.notify' },
    execute: async () => { notifyRan = true; return { status: 'success', output: {} }; },
  };
  // Attrappe eines Secret-fähigen Nodes, der den Wert absichtlich in Log und Fehler schreibt.
  const leaky = {
    type: 'test.leaky',
    metadata: { type: 'test.leaky', secretPlaceholders: true },
    execute: async (ctx) => {
      const v = ctx.runContext.secrets.T;
      ctx.logger.info(`benutze ${v}`, { detail: `x${v}x` });
      return { status: 'failed', output: { echo: v }, error: { code: 'boom', message: `kaputt: ${v}` } };
    },
  };
  // Unter einem bekannten Typ registriert — die Laufzeit-Policy lehnt unbekannte ab.
  const executors = { 'ssh.exec': sshExec, 'action.notify': notify, 'action.log': leaky };
  const registry = { get: (t) => executors[t] };
  const queue = new WorkflowQueueService();
  const noop = { record: async () => {}, create: async () => {} };
  let actor = { userId: ACTOR.userId, actor: { userId: ACTOR.userId, username: 'u', role: 'user' } };
  const accountability = { resolve: async () => actor };
  const engine = new WorkflowEngineService(
    Def, Run, NodeRun, queue, {}, registry, new EventEmitter2(), noop, {}, noop, noop, accountability, resolver,
  );
  const pos = { x: 0, y: 0 };
  async function runSingle(node) {
    const run = await Run.create({
      definitionId: new mongoose.Types.ObjectId(), definitionVersion: 1, scope: 'project', projectId: project,
      definitionSnapshot: { nodes: [node], edges: [] }, trigger: { type: 'manual' }, status: 'running',
      startedAt: new Date(), context: { nodes: { prev: { x: 1 } }, input: { a: 1 } },
    });
    for (let j = queue.peek(); j; j = queue.peek()) queue.take(j.seq);
    await engine.enqueueNode(run, node, 1);
    await engine.runJob(queue.take(queue.peek().seq));
    return {
      run: await Run.findById(run._id).lean(),
      nr: await NodeRun.findOne({ runId: run._id, nodeId: node.id }).lean(),
    };
  }

  try {
    await check('Engine: ssh.exec bekommt den Wert, NodeRun/Kontext sehen nur ••••', async () => {
      sent.length = 0;
      const node = { id: 'exec', type: 'ssh.exec', config: { connectionId: 'c', command: 'echo {{secrets.T}}' }, position: pos };
      const { run, nr } = await runSingle(node);
      assert.equal(nr.status, 'succeeded', JSON.stringify(nr.error));
      assert.deepEqual(sent, ["echo 'geheim123'"], 'echter Wert geht an den Server');
      assert.ok(nr.outputSnapshot.stdout.includes('••••'), nr.outputSnapshot.stdout);
      assert.ok(!nr.outputSnapshot.stdout.includes('geheim123'));
      assert.ok(nr.resolvedConfig.command.includes('••••(T)'), nr.resolvedConfig.command);
      assert.ok(JSON.stringify(nr.placeholders).includes('••••(T)'));
      assert.ok(!JSON.stringify(nr).includes('geheim123'), 'NodeRun ohne Klartext');
      assert.deepEqual(Object.keys(nr.inputSnapshot).sort(), ['input', 'nodes'], JSON.stringify(nr.inputSnapshot));
      assert.ok(!JSON.stringify(run.context).includes('geheim123'), 'run.context ohne Klartext');
      assert.ok(!JSON.stringify(run).includes('geheim123'), 'Run ohne Klartext');
    });

    await check('Engine: action.notify mit {{secrets.T}} → secret_not_allowed, nicht ausgeführt', async () => {
      notifyRan = false;
      const node = { id: 'n', type: 'action.notify', config: { body: '{{secrets.T}}' }, position: pos };
      const { nr } = await runSingle(node);
      assert.equal(nr.status, 'failed');
      assert.equal(nr.error.code, 'secret_not_allowed');
      assert.equal(notifyRan, false);
    });

    await check('Engine: Log, Fehler und Ausgabe eines Secret-Nodes werden maskiert', async () => {
      const node = { id: 'leak', type: 'action.log', config: { x: '{{secrets.T}}' }, position: pos };
      const { run, nr } = await runSingle(node);
      assert.equal(nr.error.code, 'boom');
      const json = JSON.stringify(nr);
      assert.ok(!json.includes('geheim123'), json);
      assert.ok(nr.error.message.includes('••••'), nr.error.message);
      assert.ok(nr.logs.some((l) => String(l.msg).includes('••••')), JSON.stringify(nr.logs));
      assert.ok(!JSON.stringify(run).includes('geheim123'));
    });

    await check('Engine: Akteur ohne Zugriff aufs Projekt → template_unresolved, kein Befehl', async () => {
      sent.length = 0;
      actor = { userId: ACTOR.userId, actor: { userId: ACTOR.userId, username: 'u', role: 'user', projectScopeMode: 'none' } };
      const node = { id: 'exec2', type: 'ssh.exec', config: { connectionId: 'c', command: 'echo {{secrets.T}}' }, position: pos };
      const { nr } = await runSingle(node);
      assert.equal(nr.error.code, 'template_unresolved');
      assert.ok(nr.error.message.includes('secrets.T'));
      assert.deepEqual(sent, []);
    });

    await check('Engine: ohne Akteur → kein Secret, ssh.exec scheitert ohne Befehl', async () => {
      sent.length = 0;
      actor = null;
      const node = { id: 'exec3', type: 'ssh.exec', config: { connectionId: 'c', command: 'echo {{secrets.T}}' }, position: pos };
      const { nr } = await runSingle(node);
      assert.equal(nr.status, 'failed');
      assert.deepEqual(sent, []);
    });
  } finally {
    await Promise.all([Def, Run, NodeRun, Secret].map((m) => m.collection.drop().catch(() => {})));
    await conn.close();
  }
})().then(() => console.log(`${passed} Checks bestanden`));
