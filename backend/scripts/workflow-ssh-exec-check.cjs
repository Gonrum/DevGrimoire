#!/usr/bin/env node
/**
 * Node `ssh.exec` gegen Attrappen (SshService, SshSessionService, SshTestService,
 * Link-Modell/Audit des echten WorkflowScopeGuard). Kein Netz, kein Mongo.
 *
 * Prüft die Reihenfolge Verbindung → Lauf-Scope → Shell-Expansion → exec und
 * dass bei jeder Ablehnung `exec` NICHT aufgerufen wird. Nach `npm run build`.
 */
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { WorkflowScopeGuard } = require('../dist/workflows/workflow-scope.guard');
const { SshExecExecutor } = require('../dist/workflows/nodes/ssh-exec.executor');
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

function makeSession(result) {
  const calls = [];
  return {
    calls,
    async exec(connId, command, opts) {
      calls.push({ connId, command, opts });
      if (result instanceof Error) throw result;
      return {
        stdout: '', stderr: '', exitCode: 0, durationMs: 12,
        truncated: { stdout: false, stderr: false }, stdoutBytes: 0, stderrBytes: 0, lastChunkAgeMs: 0,
        ...result,
      };
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

function executor(session, tester = makeTester({ ok: true })) {
  const { guard, audits } = makeGuard();
  return { exec: new SshExecExecutor(makeSsh(), session, tester, guard), audits };
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
    assert.equal(session.calls[0].command, `echo 'x'\\''; rm -rf / #'`);
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
    assert.equal(opts.cwd, '/srv/shop');
    assert.equal(opts.timeoutMs, 5000);
    assert.equal(opts.idleTimeoutMs, 0);
    assert.equal(opts.signal, c.signal);
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
  });

  await check('connectionCheck: fremde Verbindung → scope_violation, kein Test', async () => {
    const tester = makeTester({ ok: true });
    const { exec } = executor(makeSession({}), tester);
    const r = await exec.connectionCheck({ projectId: P1 }, { connectionId: CONN_FOREIGN, command: 'true' }, {}, USER);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'scope_violation');
    assert.equal(tester.calls.length, 0);
  });

  await check('connectionCheck: fehlgeschlagener Test → ok false mit Fehlercode', async () => {
    const tester = makeTester({ ok: false, error: { code: 'auth_failed', message: 'nope' } });
    const { exec } = executor(makeSession({}), tester);
    const r = await exec.connectionCheck({ projectId: P1 }, { connectionId: CONN_OWN, command: 'true' }, {}, USER);
    assert.equal(r.ok, false);
    assert.equal(r.connection.error.code, 'auth_failed');
  });

  console.log(`${passed} passed`);
})();
