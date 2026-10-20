#!/usr/bin/env node
/**
 * Node `ssh.exec` gegen Attrappen (SshService, SshSessionService, SshTestService,
 * Link-Modell/Audit des echten WorkflowScopeGuard). Kein Netz. Mit
 * MONGODB_TEST_URI (Wegwerf-Datenbank) zusätzlich: Ergebnis mit viel Ausgabe
 * durch die echte Engine — NodeRun und Lauf-Kontext bleiben strukturiert.
 *
 * Prüft die Reihenfolge Verbindung → Lauf-Scope → Shell-Expansion → exec und
 * dass bei jeder Ablehnung `exec` NICHT aufgerufen wird. Nach `npm run build`.
 */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Types } = require('mongoose');
const { WorkflowScopeGuard } = require('../dist/workflows/workflow-scope.guard');
const { SshExecExecutor, sshTimeouts } = require('../dist/workflows/nodes/ssh-exec.executor');
const { WORKFLOW_RUNTIME_LIMITS } = require('../dist/workflows/workflow-security.runtime');
const { getWorkflowNodePolicy, requiresAccountableUser, workflowSecurityIssues } = require('../dist/workflows/workflow-security.policy');
const { accountabilityRefusal } = require('../dist/workflows/engine/workflow-engine.service');
const { hasBranchEdges } = require('../dist/workflows/engine/graph-walker');

const P1 = new Types.ObjectId();
const P2 = new Types.ObjectId();
const CONN_OWN = new Types.ObjectId().toString();
const CONN_FOREIGN = new Types.ObjectId().toString();
const USER = new Types.ObjectId().toString();

function makeGuard() {
  const model = {
    find() {
      const q = { select: () => q, lean: () => q, exec: async () => [] };
      return q;
    },
  };
  const audits = [];
  return { guard: new WorkflowScopeGuard(model, { record: async (e) => void audits.push(e) }), audits };
}

function makeSsh() {
  return {
    async findById(id) {
      if (id === CONN_OWN) return { _id: new Types.ObjectId(CONN_OWN), label: 'prod-web', projectId: P1 };
      if (id === CONN_FOREIGN) return { _id: new Types.ObjectId(CONN_FOREIGN), label: 'fremd', projectId: P2 };
      const e = new Error('SshConnection not found');
      e.status = 404;
      throw e;
    },
  };
}

/** `result` als Funktion bekommt das gesendete Skript (z. B. für die Nonce). */
function makeSession(result) {
  const calls = [];
  return {
    calls,
    async exec(connId, command, opts) {
      calls.push({ connId, command, opts });
      if (result instanceof Error) throw result;
      const partial = typeof result === 'function' ? result(command) : result;
      return {
        stdout: '', stderr: '', exitCode: 0, durationMs: 12,
        truncated: { stdout: false, stderr: false }, stdoutBytes: 0, stderrBytes: 0, lastChunkAgeMs: 0,
        ...partial,
      };
    },
  };
}

/** Führt das gesendete Skript in einer echten lokalen bash aus — nur harmlose Befehle. */
function bashSession() {
  return makeSession((script) => {
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status };
  });
}

function nonceOf(script) {
  return /__DG_([0-9a-f]{12})_0_S_/.exec(script)[1];
}

/** Attrappe von WorkflowSecretsResolver: nur Metadaten, `resolve` darf nie laufen. */
function makeResolver(keys = []) {
  const calls = [];
  return {
    calls,
    async available(owner) {
      calls.push(owner);
      return keys.map((key) => ({ key, origin: 'project', ownerId: P1.toString() }));
    },
    async resolve() {
      throw new Error('connectionCheck darf nie entschlüsseln');
    },
  };
}

function makeTester(result) {
  const calls = [];
  return {
    calls,
    async testConnection(connId, opts) {
      calls.push({ connId, opts });
      return result;
    },
  };
}

function ctx(config, extra = {}) {
  return {
    run: {
      _id: new Types.ObjectId(),
      definitionId: new Types.ObjectId(),
      projectId: P1,
      scope: 'project',
    },
    nodeRun: {},
    node: { id: 'n1', type: 'ssh.exec', config },
    config,
    secretRefs: [],
    runContext: { nodes: {}, input: {} },
    logger: { info() {}, warn() {}, error() {} },
    askUser: async () => { throw new Error('no'); },
    signal: new AbortController().signal,
    accountableUserId: USER,
    ...extra,
  };
}

function executor(session, tester = makeTester({ ok: true }), resolver = makeResolver()) {
  const { guard, audits } = makeGuard();
  return { exec: new SshExecExecutor(makeSsh(), session, tester, guard, resolver), audits };
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n`, err);
    process.exitCode = 1;
  }
}

/**
 * Echte Engine (Mongo) mit dem Ergebnis eines echten `ssh.exec`-Laufs (lokale
 * bash, kein SSH): drei Zeilen à 3 000 Zeichen stdout + 1 000 stderr. Vorher
 * kollabierte das in NodeRun und Lauf-Kontext zu `{ redacted, truncated }` —
 * keine Zeilentabelle, `{{nodes.exec.exitCode}}` unauflösbar.
 */
async function mongoChecks() {
  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) {
    console.log('(Engine-Checks übersprungen: MONGODB_TEST_URI nicht gesetzt)');
    return;
  }
  const path = require('node:path');
  const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));
  const { EventEmitter2 } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/event-emitter'));
  require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/common')).Logger.overrideLogger(['error', 'warn']);
  const { WorkflowEngineService } = require('../dist/workflows/engine/workflow-engine.service');
  const { WorkflowQueueService } = require('../dist/workflows/engine/workflow-queue.service');
  const { WorkflowRunSchema } = require('../dist/workflows/schemas/workflow-run.schema');
  const { WorkflowNodeRunSchema } = require('../dist/workflows/schemas/workflow-node-run.schema');
  const { WorkflowDefinitionSchema } = require('../dist/workflows/schemas/workflow-definition.schema');

  // Ergebnis des echten Executors vorab erzeugen; in der Engine liefert es
  // ein Node eines Typs ohne Akteur-Pflicht (sonst bräuchte es Akteur,
  // Secrets-Auflösung und Verbindung).
  const line = "printf 'o%.0s' $(seq 3000); printf 'e%.0s' $(seq 1000) >&2";
  const sshResult = await executor(bashSession()).exec.execute(
    ctx({ connectionId: CONN_OWN, command: [line, line, line].join('\n') }),
  );
  assert.equal(sshResult.status, 'success', JSON.stringify(sshResult.error));

  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  const suffix = `_sshexeccheck_${Date.now()}`;
  const Def = conn.model('WorkflowDefinition', WorkflowDefinitionSchema, `workflowdefinitions${suffix}`);
  const Run = conn.model('WorkflowRun', WorkflowRunSchema, `workflowruns${suffix}`);
  const NodeRun = conn.model('WorkflowNodeRun', WorkflowNodeRunSchema, `workflownoderuns${suffix}`);
  const seen = [];
  const registry = {
    get: () => ({
      execute: async (c) => {
        if (c.node.id === 'exec') return sshResult;
        seen.push(c.config.message);
        return { status: 'success', output: { message: c.config.message } };
      },
    }),
  };
  const queue = new WorkflowQueueService();
  const noop = { record: async () => {}, create: async () => {} };
  const engine = new WorkflowEngineService(
    Def, Run, NodeRun, queue, {}, registry, new EventEmitter2(), noop, {}, noop, noop, { resolve: async () => null },
  );
  const pos = { x: 0, y: 0 };
  const execNode = { id: 'exec', type: 'action.log', config: { message: 'ssh' }, position: pos };
  const next = { id: 'next', type: 'action.log', config: { message: 'exit={{nodes.exec.exitCode}}' }, position: pos };
  try {
    await check('Engine: viel ssh.exec-Ausgabe bleibt strukturiert, Folge-Node löst {{nodes.exec.exitCode}} auf', async () => {
      const run = await Run.create({
        definitionId: new mongoose.Types.ObjectId(), definitionVersion: 1, scope: 'system',
        definitionSnapshot: { nodes: [execNode, next], edges: [{ id: 'e1', source: 'exec', target: 'next' }] },
        trigger: { type: 'manual' }, status: 'running', startedAt: new Date(), context: { nodes: {} },
      });
      await engine.enqueueNode(run, execNode, 1);
      for (let i = 0; i < 5 && queue.peek(); i += 1) await engine.runJob(queue.take(queue.peek().seq));

      const nr = await NodeRun.findOne({ runId: run._id, nodeId: 'exec' }).lean();
      assert.equal(nr.status, 'succeeded', JSON.stringify(nr.error));
      assert.equal(nr.outputSnapshot.redacted, undefined, JSON.stringify(nr.outputSnapshot).slice(0, 200));
      assert.ok(Array.isArray(nr.outputSnapshot.lines), 'lines ist Array');
      assert.equal(nr.outputSnapshot.lines.length, 3);
      for (const l of nr.outputSnapshot.lines) {
        assert.equal(l.exitCode, 0);
        assert.equal(l.truncated, true);
        assert.equal(l.stdout.length, 2000);
        assert.equal(l.stderr.length, 1000);
      }
      assert.equal(nr.outputSnapshot.exitCode, 0);
      assert.ok(JSON.stringify(nr.outputSnapshot).length <= 20_000);

      const fresh = await Run.findById(run._id).lean();
      assert.equal(typeof fresh.context.nodes.exec.exitCode, 'number', JSON.stringify(fresh.context.nodes.exec).slice(0, 200));
      assert.equal(fresh.context.nodes.exec.lines.length, 3);
      // Die Vorprüfung hätte den Folge-Node mit template_unresolved scheitern lassen.
      const after = await NodeRun.findOne({ runId: run._id, nodeId: 'next' }).lean();
      assert.equal(after.status, 'succeeded', JSON.stringify(after.error));
      assert.equal(after.resolvedConfig.message, 'exit=0');
      assert.equal(seen.length, 1);
      assert.equal(fresh.status, 'succeeded');
    });
  } finally {
    await Promise.all([Def, Run, NodeRun].map((m) => m.collection.drop().catch(() => {})));
    await conn.close();
  }
}

(async () => {
  await check('Policy: ssh.exec ist external-call, Projekt+Kunde, MVP, braucht Akteur', async () => {
    const p = getWorkflowNodePolicy('ssh.exec');
    assert.ok(p);
    assert.equal(p.risk, 'external-call');
    assert.deepEqual([...p.allowedScopes].sort(), ['customer', 'project']);
    assert.equal(p.mvpAllowed, true);
    assert.equal(requiresAccountableUser(p.risk), true);
    assert.deepEqual(workflowSecurityIssues({ scope: 'project', nodes: [{ id: 'a', type: 'ssh.exec' }] }), []);
    assert.equal(workflowSecurityIssues({ scope: 'system', nodes: [{ id: 'a', type: 'ssh.exec' }] }).length, 1);
  });

  await check('Engine-Gate: ssh.exec ohne Akteur → no_accountable_user, failure-Edge greift', async () => {
    const r = accountabilityRefusal('ssh.exec', false);
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'no_accountable_user');
    assert.equal(accountabilityRefusal('ssh.exec', true), undefined);
    const graph = { nodes: [], edges: [{ id: 'e', source: 'ssh', target: 'alarm', branch: 'failure' }] };
    assert.equal(hasBranchEdges('ssh', 'failure', graph), true);
  });

  await check('Verbindung fremden Projekts → scope_violation, exec nicht aufgerufen', async () => {
    const session = makeSession({});
    const { exec, audits } = executor(session);
    const r = await exec.execute(ctx({ connectionId: CONN_FOREIGN, command: 'true' }));
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'scope_violation');
    assert.equal(session.calls.length, 0);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].meta.entity.type, 'ssh-connection');
  });

  await check('command mit fehlendem {{t}} → template_unresolved, exec nicht aufgerufen', async () => {
    const session = makeSession({});
    const { exec } = executor(session);
    const r = await exec.execute(ctx({ connectionId: CONN_OWN, command: 'echo {{t}}' }));
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'template_unresolved');
    assert.match(r.error.message, /\bt\b/);
    assert.deepEqual(r.error.details.missing, ['t']);
    assert.equal(session.calls.length, 0);
  });

  await check('Werte im command werden shell-sicher gequotet', async () => {
    const session = makeSession({});
    const { exec } = executor(session);
    const c = ctx({ connectionId: CONN_OWN, command: 'echo {{input.t}}' });
    c.runContext = { nodes: {}, input: { t: "x'; rm -rf / #" } };
    const r = await exec.execute(c);
    assert.equal(r.status, 'success');
    assert.ok(session.calls[0].command.includes(`\necho 'x'\\''; rm -rf / #'\n`), session.calls[0].command);
    assert.equal(session.calls[0].opts.auditCommand, `echo 'x'\\''; rm -rf / #'`);
  });

  await check('unaufgelöstes Template in connectionId → template_unresolved, kein Laden', async () => {
    const session = makeSession({});
    const { exec } = executor(session);
    const r = await exec.execute(ctx({ connectionId: '{{nodes.x.id}}', command: 'true' }));
    assert.equal(r.error.code, 'template_unresolved');
    assert.equal(session.calls.length, 0);
  });

  await check('Exit 0 → success, output.stdout gesetzt, Label als connection', async () => {
    const session = makeSession({ stdout: 'hallo\n', exitCode: 0 });
    const { exec } = executor(session);
    const r = await exec.execute(ctx({ connectionId: CONN_OWN, command: 'echo hallo' }));
    assert.equal(r.status, 'success');
    assert.equal(r.output.stdout, 'hallo\n');
    assert.equal(r.output.exitCode, 0);
    assert.equal(r.output.connection, 'prod-web');
    assert.equal(r.output.aborted, null);
  });

  await check('Exit 2, failOnNonZeroExit default → failed nonzero_exit mit output', async () => {
    const session = makeSession({ exitCode: 2, stderr: 'kaputt' });
    const { exec } = executor(session);
    const r = await exec.execute(ctx({ connectionId: CONN_OWN, command: 'false' }));
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'nonzero_exit');
    assert.equal(r.output.exitCode, 2);
    assert.equal(r.output.stderr, 'kaputt');
  });

  await check('Exit 2, failOnNonZeroExit:false → success', async () => {
    const session = makeSession({ exitCode: 2 });
    const { exec } = executor(session);
    const r = await exec.execute(ctx({ connectionId: CONN_OWN, command: 'false', failOnNonZeroExit: false }));
    assert.equal(r.status, 'success');
    assert.equal(r.output.exitCode, 2);
  });

  await check('exec erhält sourceContext workflow, userId = accountableUserId, workflow-Ids, signal', async () => {
    const session = makeSession({});
    const { exec } = executor(session);
    const c = ctx({ connectionId: CONN_OWN, command: 'uptime', cwd: '/srv/{{input.app}}', timeoutMs: 5000, idleTimeoutMs: 0 });
    c.runContext = { nodes: {}, input: { app: 'shop' } };
    await exec.execute(c);
    const { connId, opts } = session.calls[0];
    assert.equal(connId, CONN_OWN);
    assert.equal(opts.sourceContext, 'workflow');
    assert.equal(opts.userId, USER);
    assert.equal(opts.workflow.runId, c.run._id.toString());
    assert.equal(opts.workflow.nodeId, 'n1');
    assert.equal(opts.workflow.definitionId, c.run.definitionId.toString());
    // cwd steht im Skript (cd || exit), nicht in opts.cwd: dort bände `&&` nur die erste Zeile.
    assert.equal(opts.cwd, undefined);
    assert.ok(session.calls[0].command.startsWith(`cd -- '/srv/shop' || exit $?\n`), session.calls[0].command);
    assert.equal(opts.workflow.debug, false);
    assert.equal(opts.auditCommand, 'uptime');
    // SSH läuft 5 s vor dem Engine-Timeout ab (R7), Untergrenze 1 s.
    assert.equal(opts.timeoutMs, 1000);
    assert.equal(opts.idleTimeoutMs, 0);
    assert.equal(opts.signal, c.signal);
  });

  await check('SSH-Timeout 5 s vor dem Engine-Timeout, Idle geklemmt', async () => {
    assert.equal(sshTimeouts({ timeoutMs: 60000 }).timeoutMs, 55000);
    assert.equal(sshTimeouts({ timeoutMs: 3000 }).timeoutMs, 1000);
    assert.equal(sshTimeouts({}).timeoutMs, WORKFLOW_RUNTIME_LIMITS.defaultNodeTimeoutMs - 5000);
    assert.equal(sshTimeouts({ timeoutMs: 60000, idleTimeoutMs: 600000 }).idleTimeoutMs, 55000);
    assert.equal(sshTimeouts({ timeoutMs: 60000, idleTimeoutMs: 0 }).idleTimeoutMs, 0);
    // Ohne Angabe gilt der Leerlauf-Default (30 s) — sichtbar statt erst im SSH-Stack.
    assert.equal(sshTimeouts({ timeoutMs: 60000 }).idleTimeoutMs, 30000);
  });

  await check('aborted timeout/idle/cancelled → failed mit Code und output', async () => {
    for (const [aborted, code] of [['timeout', 'timeout'], ['idle', 'idle_timeout'], ['cancelled', 'cancelled']]) {
      const session = makeSession({ exitCode: null, signal: 'SIGTERM', aborted, stdout: 'teil' });
      const { exec } = executor(session);
      const r = await exec.execute(ctx({ connectionId: CONN_OWN, command: 'sleep 99', failOnNonZeroExit: false }));
      assert.equal(r.status, 'failed', aborted);
      assert.equal(r.error.code, code, aborted);
      assert.equal(r.output.aborted, code, aborted);
      assert.equal(r.output.stdout, 'teil', aborted);
    }
  });

  await check('Verbindungsfehler → ssh_error, Meldung gekappt', async () => {
    const session = makeSession(new Error('credential_missing'));
    const { exec } = executor(session);
    const r = await exec.execute(ctx({ connectionId: CONN_OWN, command: 'true' }));
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'ssh_error');
    assert.equal(r.error.message, 'credential_missing');
    const long = makeSession(new Error('x'.repeat(2000)));
    const r2 = await executor(long).exec.execute(ctx({ connectionId: CONN_OWN, command: 'true' }));
    assert.ok(r2.error.message.length <= 500);
  });

  await check('unbekannte Verbindung → ssh_error, exec nicht aufgerufen', async () => {
    const session = makeSession({});
    const r = await executor(session).exec.execute(ctx({ connectionId: new Types.ObjectId().toString(), command: 'true' }));
    assert.equal(r.error.code, 'ssh_error');
    assert.equal(session.calls.length, 0);
  });

  await check('bereits abgebrochenes Signal → cancelled, exec nicht aufgerufen', async () => {
    const session = makeSession({});
    const ac = new AbortController();
    ac.abort();
    const r = await executor(session).exec.execute(ctx({ connectionId: CONN_OWN, command: 'true' }, { signal: ac.signal }));
    assert.equal(r.error.code, 'cancelled');
    assert.equal(session.calls.length, 0);
  });

  await check('ungültige Config (timeoutMs > 600000) → invalid_config, exec nicht aufgerufen', async () => {
    const session = makeSession({});
    const r = await executor(session).exec.execute(ctx({ connectionId: CONN_OWN, command: 'true', timeoutMs: 700000 }));
    assert.equal(r.error.code, 'invalid_config');
    assert.equal(session.calls.length, 0);
  });

  await check('connectionCheck: ok aus dem Test, kein exec, keine Secrets', async () => {
    const session = makeSession({});
    const tester = makeTester({ ok: true, fingerprint: 'ab:cd', fingerprintAccepted: true });
    const { exec } = executor(session, tester);
    const r = await exec.connectionCheck({ projectId: P1 }, { connectionId: CONN_OWN, command: 'rm -rf /' }, {}, USER);
    assert.equal(r.ok, true);
    assert.equal(r.executable, false);
    assert.equal(r.mode, 'connection_check');
    assert.equal(r.reason, 'Befehl wird im Test nicht ausgeführt');
    assert.equal(r.connection.label, 'prod-web');
    assert.equal(r.connection.ok, true);
    assert.deepEqual(tester.calls[0], { connId: CONN_OWN, opts: { userId: USER } });
    assert.equal(session.calls.length, 0);
    // Der Test-Dialog rendert nur *Preview-Felder (Final-Review I3).
    assert.deepEqual(r.outputPreview, { ...r.connection, commands: [{ line: 1, command: 'rm -rf /' }] });
    assert.deepEqual(r.commands, [{ line: 1, command: 'rm -rf /' }]);
    assert.equal(r.errorPreview, undefined);
  });

  await check('connectionCheck: fremde Verbindung → scope_violation, kein Test', async () => {
    const tester = makeTester({ ok: true });
    const { exec } = executor(makeSession({}), tester);
    const r = await exec.connectionCheck({ projectId: P1 }, { connectionId: CONN_FOREIGN, command: 'true' }, {}, USER);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'scope_violation');
    assert.deepEqual(r.errorPreview, r.error);
    assert.equal(tester.calls.length, 0);
  });

  await check('connectionCheck: fehlgeschlagener Test → ok false mit Fehlercode', async () => {
    const tester = makeTester({ ok: false, error: { code: 'auth_failed', message: 'nope' } });
    const { exec } = executor(makeSession({}), tester);
    const r = await exec.connectionCheck({ projectId: P1 }, { connectionId: CONN_OWN, command: 'true' }, {}, USER);
    assert.equal(r.ok, false);
    assert.equal(r.connection.error.code, 'auth_failed');
    // Der Grund muss im Dialog sichtbar sein: errorPreview/outputPreview.
    assert.deepEqual(r.errorPreview, { code: 'auth_failed', message: 'nope' });
    assert.equal(r.outputPreview.label, 'prod-web');
  });

  await check('connectionCheck: ungültige Config / unbekannte Verbindung → errorPreview gesetzt', async () => {
    const { exec } = executor(makeSession({}), makeTester({ ok: true }));
    const bad = await exec.connectionCheck({ projectId: P1 }, { connectionId: CONN_OWN }, {}, USER);
    assert.equal(bad.errorPreview.code, 'invalid_config');
    const unknown = await exec.connectionCheck({ projectId: P1 }, { connectionId: 'gibts-nicht', command: 'true' }, {}, USER);
    assert.equal(unknown.errorPreview.code, 'ssh_error');
  });

  await check('command mit Platzhalter in Anführungszeichen → template_unresolved mit Grund, kein exec', async () => {
    const session = makeSession({});
    const { exec } = executor(session);
    const c = ctx({ connectionId: CONN_OWN, command: 'git commit -m "{{nodes.find.todo.title}}"' });
    c.runContext = { nodes: { find: { todo: { title: '$(touch /tmp/pwn)' } } }, input: {} };
    const r = await exec.execute(c);
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'template_unresolved');
    assert.match(r.error.message, /Platzhalter in Anführungszeichen: nodes\.find\.todo\.title/);
    assert.match(r.error.message, /ohne Anführungszeichen schreiben/);
    assert.doesNotMatch(r.error.message, /nicht darstellbar/);
    assert.deepEqual(r.error.details.quoted, ['nodes.find.todo.title']);
    assert.equal(session.calls.length, 0);
    // Die Node-Beschreibung (Palette/MCP) nennt die Regel.
    assert.match(exec.metadata.description, /nie selbst in Anführungszeichen/);
  });

  await check('mehrzeilig, echte Shell: Zeile 2 scheitert → nonzero_exit mit Zeilenmeldung, Zeile 3 läuft nicht', async () => {
    const session = bashSession();
    const r = await executor(session).exec.execute(ctx({ connectionId: CONN_OWN, command: 'echo eins\n# kommentar\nfalse\necho nie' }));
    assert.equal(r.status, 'failed');
    assert.equal(r.error.code, 'nonzero_exit');
    assert.equal(r.error.message, 'Zeile 3 endete mit Exit-Code 1');
    assert.equal(r.output.exitCode, 1);
    assert.equal(r.output.stdout, 'eins\n');
    assert.deepEqual(r.output.lines.map((l) => [l.line, l.command, l.exitCode, l.stdout]), [
      [1, 'echo eins', 0, 'eins\n'],
      [3, 'false', 1, ''],
    ]);
    // Ins Audit geht der eingesetzte Befehl ohne Marker.
    assert.equal(session.calls[0].opts.auditCommand, 'echo eins\nfalse\necho nie');
    assert.ok(!session.calls[0].opts.auditCommand.includes('__DG_'));
    assert.equal(executor(makeSession({})).exec.metadata.outputs.lines, 'array');
  });

  await check('mehrzeilig, failOnNonZeroExit:false: alle Zeilen laufen, exitCode der letzten', async () => {
    const session = bashSession();
    const r = await executor(session).exec.execute(
      ctx({ connectionId: CONN_OWN, command: 'false\necho weiter', failOnNonZeroExit: false }),
    );
    assert.equal(r.status, 'success');
    assert.equal(r.output.lines.length, 2);
    assert.equal(r.output.lines[0].exitCode, 1);
    assert.equal(r.output.exitCode, 0);
  });

  await check('Leerlauf-Abbruch in Zeile 2 → idle_timeout mit sichtbarer Grenze', async () => {
    const session = makeSession((script) => {
      const n = nonceOf(script);
      return {
        stdout: `\n__DG_${n}_0_S_1\na\n\n__DG_${n}_0_E_0_2\n\n__DG_${n}_1_S_3\n`,
        exitCode: null, signal: 'SIGTERM', aborted: 'idle',
      };
    });
    const r = await executor(session).exec.execute(ctx({ connectionId: CONN_OWN, command: 'echo a\nsleep 999\necho c' }));
    assert.equal(r.error.code, 'idle_timeout');
    assert.equal(r.error.message, 'Zeile 2 abgebrochen: 30 s ohne Ausgabe');
    assert.equal(r.output.lines[1].aborted, 'idle_timeout');
    assert.equal(session.calls[0].opts.idleTimeoutMs, 30000);
    const t = makeSession((script) => ({ stdout: `\n__DG_${nonceOf(script)}_0_S_1\n`, exitCode: null, aborted: 'timeout' }));
    const rt = await executor(t).exec.execute(ctx({ connectionId: CONN_OWN, command: 'sleep 999', timeoutMs: 60000 }));
    assert.equal(rt.error.code, 'timeout');
    assert.equal(rt.error.message, 'Zeile 1 abgebrochen: Zeitlimit 55 s erreicht');
  });

  await check('Audit: Secret roh und shell-gequotet (mit Apostroph) maskiert, gesendet im Klartext', async () => {
    const session = makeSession({});
    const c = ctx({ connectionId: CONN_OWN, command: 'login {{secrets.T}}\necho {{{secrets.T}}}' });
    c.runContext = { nodes: {}, input: {}, secrets: { T: "ab'cdefg" } };
    c.secretValues = ["ab'cdefg"];
    await executor(session).exec.execute(c);
    const { command, opts } = session.calls[0];
    assert.ok(command.includes(`login 'ab'\\''cdefg'`), command);
    assert.ok(command.includes(`echo ab'cdefg`), command);
    assert.equal(opts.auditCommand, 'login ••••(T)\necho ••••(T)');
  });

  await check('output.lines[].command: gequotete Secret-Form maskiert (echte Shell)', async () => {
    const session = bashSession();
    const c = ctx({ connectionId: CONN_OWN, command: 'true {{secrets.T}}' });
    c.runContext = { nodes: {}, input: {}, secrets: { T: "ab'cdefg" } };
    c.secretValues = ["ab'cdefg"];
    const r = await executor(session).exec.execute(c);
    assert.equal(r.status, 'success');
    assert.equal(r.output.lines[0].command, 'true ••••(T)');
    assert.ok(!JSON.stringify(r).includes('cdefg'), JSON.stringify(r));
  });

  await check('Quote über das Zeilenende / nur Kommentare → invalid_config, kein exec', async () => {
    const session = makeSession({});
    const { exec } = executor(session);
    const open = await exec.execute(ctx({ connectionId: CONN_OWN, command: 'echo "a\n{{input.t}}"' }));
    assert.equal(open.error.code, 'invalid_config');
    assert.match(open.error.message, /^Zeile 1: Anführungszeichen nicht geschlossen/);
    const empty = await exec.execute(ctx({ connectionId: CONN_OWN, command: '# nur\n\n' }));
    assert.equal(empty.error.code, 'invalid_config');
    assert.equal(session.calls.length, 0);
  });

  await check('fehlende Platzhalter über mehrere Zeilen gesammelt', async () => {
    const session = makeSession({});
    const r = await executor(session).exec.execute(ctx({ connectionId: CONN_OWN, command: 'echo {{a}}\necho {{b}} {{a}}' }));
    assert.equal(r.error.code, 'template_unresolved');
    assert.deepEqual(r.error.details.missing, ['a', 'b']);
    assert.equal(session.calls.length, 0);
  });

  await check('connectionCheck: verfügbares Secret als ••••(KEY), Aufrufer-Secrets ignoriert, nie entschlüsselt', async () => {
    const resolver = makeResolver(['T']);
    const { exec } = executor(makeSession({}), makeTester({ ok: true }), resolver);
    const r = await exec.connectionCheck(
      { projectId: P1 },
      { connectionId: CONN_OWN, command: 'cd /x\nlogin {{secrets.T}} {{{secrets.T}}}' },
      { nodes: {}, input: {}, secrets: { T: 'vom-aufrufer-123' } },
      USER,
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.commands, [
      { line: 1, command: 'cd /x' },
      { line: 2, command: 'login ••••(T) ••••(T)' },
    ]);
    assert.ok(!JSON.stringify(r).includes('vom-aufrufer-123'));
    assert.ok(!JSON.stringify(r).includes('__DG_SECRET_'));
    assert.deepEqual(resolver.calls, [{ projectId: P1.toString(), customerId: undefined }]);
  });

  await check('connectionCheck: nicht verfügbarer KEY → commandProblem, Aufrufer-Wert zählt nicht', async () => {
    const resolver = makeResolver(['T']);
    const { exec } = executor(makeSession({}), makeTester({ ok: true }), resolver);
    const r = await exec.connectionCheck(
      { projectId: P1 },
      { connectionId: CONN_OWN, command: 'login {{secrets.U}}' },
      { nodes: {}, input: {}, secrets: { U: 'vom-aufrufer-123' } },
      USER,
    );
    assert.equal(r.commands, undefined);
    assert.equal(r.commandProblem.code, 'template_unresolved');
    assert.match(r.commandProblem.message, /secrets\.U/);
    assert.deepEqual(r.outputPreview.commandProblem, r.commandProblem);
    assert.ok(!JSON.stringify(r).includes('vom-aufrufer-123'));
    // Ohne Secret-Platzhalter keine Abfrage.
    const plain = makeResolver([]);
    await executor(makeSession({}), makeTester({ ok: true }), plain).exec.connectionCheck(
      { projectId: P1 }, { connectionId: CONN_OWN, command: 'true' }, {}, USER,
    );
    assert.equal(plain.calls.length, 0);
  });

  await check('kurze Secrets (3 und 1 Zeichen) weder im Audit noch in lines[].command (echte Shell)', async () => {
    for (const [value, command] of [
      ['a1b', 'true {{{secrets.T}}}'],
      ['a1b', 'true {{secrets.T}}'],
      ['Z', 'true {{secrets.T}} {{{secrets.T}}}'],
    ]) {
      const session = bashSession();
      const c = ctx({ connectionId: CONN_OWN, command });
      c.runContext = { nodes: {}, input: {}, secrets: { T: value } };
      c.secretValues = [value];
      const r = await executor(session).exec.execute(c);
      assert.equal(r.status, 'success', command);
      const audit = session.calls[0].opts.auditCommand;
      assert.ok(!audit.includes(value), `${command}: ${audit}`);
      assert.ok(audit.startsWith('true ••••(T)'), audit);
      assert.ok(!r.output.lines[0].command.includes(value), r.output.lines[0].command);
      assert.equal(r.output.lines[0].command, audit);
      // An den Server geht der echte Wert.
      assert.ok(session.calls[0].command.includes(value));
    }
  });

  await check('Kommentar mit Apostroph wird angenommen und läuft (echte Shell)', async () => {
    const session = bashSession();
    const r = await executor(session).exec.execute(ctx({ connectionId: CONN_OWN, command: "echo hi # it's done" }));
    assert.equal(r.status, 'success', JSON.stringify(r.error));
    assert.equal(r.output.stdout, 'hi\n');
    assert.equal(r.output.lines[0].command, "echo hi # it's done");
  });

  await check('Zeile endet mit | / && / || oder Here-Doc → invalid_config mit Zeile, kein exec', async () => {
    const session = makeSession({});
    const { exec } = executor(session);
    for (const [command, message] of [
      ['ls |\nwc -l', 'Zeile 1: Befehl endet mit "|" — mehrzeilige Konstrukte werden nicht unterstützt, bitte in eine Zeile schreiben oder mit \\ fortsetzen'],
      ['true\nmake &&\nmake install', 'Zeile 2: Befehl endet mit "&&" — mehrzeilige Konstrukte werden nicht unterstützt, bitte in eine Zeile schreiben oder mit \\ fortsetzen'],
      ['test -f x ||\ntouch x', 'Zeile 1: Befehl endet mit "||" — mehrzeilige Konstrukte werden nicht unterstützt, bitte in eine Zeile schreiben oder mit \\ fortsetzen'],
      ['cat <<EOF\nhallo\nEOF', 'Zeile 1: Here-Docs werden nicht unterstützt'],
    ]) {
      const r = await exec.execute(ctx({ connectionId: CONN_OWN, command }));
      assert.equal(r.error.code, 'invalid_config', command);
      assert.equal(r.error.message, message);
    }
    assert.equal(session.calls.length, 0);
  });

  await check('Operatoren/<< in Quotes oder Kommentar sind erlaubt (echte Shell)', async () => {
    const session = bashSession();
    const r = await executor(session).exec.execute(
      ctx({ connectionId: CONN_OWN, command: 'echo "a |" \'<<b &&\'\necho ok # sonst && <<EOF' }),
    );
    assert.equal(r.status, 'success', JSON.stringify(r.error));
    assert.equal(r.output.stdout, 'a | <<b &&\nok\n');
  });

  await check('Mehrzeilige Blöcke (if/for/while/case/{ }) → invalid_config mit Zeile, kein exec', async () => {
    const session = makeSession({});
    const { exec } = executor(session);
    const msg = (n) =>
      `Zeile ${n}: mehrzeilige Konstrukte (if/for/while/case/{ }) werden nicht unterstützt — bitte in eine Zeile schreiben oder mit \\ fortsetzen`;
    for (const [command, line] of [
      ['if [ -f x ]; then\necho ja\nfi', 1],
      ['if true\nthen echo a; fi', 2],
      ['for i in 1 2; do\necho $i\ndone', 1],
      ['for i in 1 2\ndo echo $i; done', 2],
      ['while true; do\nsleep 1\ndone', 1],
      ['case "$x" in\na) echo a;;\nesac', 1],
      ['true\nf() {\necho\n}', 2],
      ['echo a\nelse', 2],
      ['echo a\nelse echo b; fi', 2],
      ['echo a\ndo echo b; done', 2],
      ['echo a\nelif true; then echo b; fi', 2],
      ['echo a\nfi', 2],
      ['echo a\ndone', 2],
      ['echo a\nesac', 2],
      ['echo a\n}', 2],
      ['if true; then # Kommentar\necho\nfi', 1],
    ]) {
      const r = await exec.execute(ctx({ connectionId: CONN_OWN, command }));
      assert.equal(r.status, 'failed', command);
      assert.equal(r.error.code, 'invalid_config', command);
      assert.equal(r.error.message, msg(line), command);
    }
    assert.equal(session.calls.length, 0);
  });

  await check('Einzeilige Blöcke und Schlüsselwörter als Argument/in Quotes laufen (echte Shell)', async () => {
    const session = bashSession();
    const command = [
      'if true; then echo a; fi',
      'for i in 1 2; do echo $i; done',
      'case x in x) echo c;; esac',
      '{ echo d; }',
      'echo then do fi',
      'echo "if x; then" \'{\'',
      'echo login',
    ].join('\n');
    const r = await executor(session).exec.execute(ctx({ connectionId: CONN_OWN, command }));
    assert.equal(r.status, 'success', JSON.stringify(r.error));
    assert.equal(r.output.stdout, 'a\n1\n2\nc\nd\nthen do fi\nif x; then {\nlogin\n');
  });

  await check('Debug-Lauf: SSH-Audit trägt workflow.debug = true', async () => {
    const session = makeSession({});
    const c = ctx({ connectionId: CONN_OWN, command: 'true' });
    c.run.mode = 'debug';
    await executor(session).exec.execute(c);
    assert.equal(session.calls[0].opts.workflow.debug, true);
  });

  await check('dryRunPreview: Platzhalter-Ausgabe + Vorschau, nichts gesendet, nichts entschlüsselt', async () => {
    const session = makeSession({});
    const resolver = makeResolver(['T']);
    const tester = makeTester({ ok: true, fingerprint: 'ab:cd', fingerprintAccepted: true });
    const { exec } = executor(session, tester, resolver);
    const c = ctx({ connectionId: CONN_OWN, command: 'login {{secrets.T}}\necho {{input.x}}' });
    c.runContext = { nodes: {}, input: { x: 'hi' }, secrets: { T: 'klartext-geheim' } };
    const r = await exec.dryRunPreview(c);
    assert.equal(r.status, 'success', JSON.stringify(r.error));
    assert.equal(r.output.dryRun, true);
    assert.equal(r.output.exitCode, null);
    assert.equal(r.output.stdout, null);
    assert.equal(r.output.preview.connection.label, 'prod-web');
    assert.deepEqual(r.output.preview.commands, [
      { line: 1, command: 'login ••••(T)' },
      { line: 2, command: "echo 'hi'" },
    ]);
    assert.equal(session.calls.length, 0);
    assert.ok(!JSON.stringify(r).includes('klartext-geheim'));
  });

  await check('dryRunPreview: fehlgeschlagener Verbindungstest → failed mit Code', async () => {
    const tester = makeTester({ ok: false, error: { code: 'auth_failed', message: 'nope' } });
    const { exec } = executor(makeSession({}), tester);
    const r = await exec.dryRunPreview(ctx({ connectionId: CONN_OWN, command: 'true' }));
    assert.equal(r.status, 'failed');
    assert.deepEqual(r.error, { code: 'auth_failed', message: 'nope' });
    assert.equal(r.output.dryRun, true);
    const foreign = await exec.dryRunPreview(ctx({ connectionId: CONN_FOREIGN, command: 'true' }));
    assert.equal(foreign.error.code, 'scope_violation');
  });

  await check('Zeilen-Ausgabe: je Zeile nur die letzten 2 000 Zeichen + truncated, Gesamtausgabe vollständig', async () => {
    const session = bashSession();
    const command = [
      "printf 'A%.0s' $(seq 2999); printf 'Z'",
      "printf 'kurz'",
    ].join('\n');
    const r = await executor(session).exec.execute(ctx({ connectionId: CONN_OWN, command }));
    assert.equal(r.status, 'success', JSON.stringify(r.error));
    const [first, second] = r.output.lines;
    assert.equal(first.stdout.length, 2000);
    assert.ok(first.stdout.endsWith('AZ'), 'das Ende bleibt');
    assert.equal(first.truncated, true);
    assert.equal(second.stdout, 'kurz');
    assert.equal(second.truncated, false);
    assert.equal(r.output.stdout.length, 3004, 'Gesamt-stdout ungekürzt');
  });

  for (const stream of ['stdout', 'stderr']) {
    await check(`Zeilen-Ausgabe: Secret am 2000-Zeichen-Schnitt (${stream}) bleibt nicht als Suffix stehen`, async () => {
      const secret = 'geheimTOKEN123';
      const fd = stream === 'stdout' ? '' : ' >&2';
      // Schnitt fällt mitten ins Secret: nach dem Secret bleiben 1 995 Zeichen,
      // vom Secret bliebe roh nur das Ende (die letzten 5 Zeichen).
      const command = [
        `printf 'x%.0s' $(seq 500)${fd}`,
        `printf '%s' '${secret}'${fd}`,
        `printf 'y%.0s' $(seq 1995)${fd}`,
      ].join('; ');
      const c = ctx({ connectionId: CONN_OWN, command });
      c.secretValues = [secret];
      const r = await executor(bashSession()).exec.execute(c);
      assert.equal(r.status, 'success', JSON.stringify(r.error));
      const line = r.output.lines[0];
      assert.equal(line.truncated, true);
      const text = line[stream];
      assert.ok(text.length <= 2000);
      assert.ok(!text.includes(secret), 'volles Secret');
      for (let i = 0; i + 4 <= secret.length; i++) {
        assert.ok(!text.includes(secret.slice(i, i + 4)), `Teilstück ${secret.slice(i, i + 4)}`);
      }
    });
  }

  await check('Zeilen-Ausgabe: Bearer-Token bleibt auch bei Schnitt hinter „Bearer " maskiert', async () => {
    const token = 'abcDEF1234567890xyz';
    // „Authorization: Bearer " liegt vor dem Schnitt, das Token ragt in die letzten 2 000 Zeichen.
    const command = `printf 'Authorization: Bearer %s' '${token}'; printf 'y%.0s' $(seq 1990)`;
    const r = await executor(bashSession()).exec.execute(ctx({ connectionId: CONN_OWN, command }));
    assert.equal(r.status, 'success', JSON.stringify(r.error));
    const line = r.output.lines[0];
    assert.equal(line.truncated, true);
    assert.ok(!line.stdout.includes(token.slice(-8)), line.stdout.slice(0, 40));
    assert.ok(!line.stdout.includes('Bearer ' + token));
  });

  await mongoChecks();

  console.log(`${passed} passed`);
})();
