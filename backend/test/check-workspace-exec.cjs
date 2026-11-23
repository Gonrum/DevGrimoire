#!/usr/bin/env node
/*
 * `exec` of the workspace file backends (agent chat, Task 2):
 * - ContainerFsBackend over a faked `WorkspaceClient.execStream`
 * - SshFsBackend over the local stand-in session (test/lib/local-remote-session.cjs),
 *   whose agent shape records the command and answers with a script — the
 *   command itself never runs
 * - SshWorkspaceSessions: the abort signal reaches the driver, a queued exec
 *   gives up its place on abort
 *
 * Loads from dist/; run `npm run build` first. No database, no network.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}
const nm = (m) => require(path.resolve(__dirname, '..', 'node_modules', m));
require(path.resolve(__dirname, '..', 'node_modules', 'reflect-metadata'));

const { RemoteError } = loadCompiled('workspaces/fs/remote-session.js');
const { SshFsBackend } = loadCompiled('workspaces/fs/ssh-fs-backend.js');
const { ContainerFsBackend } = loadCompiled('workspaces/fs/container-fs-backend.js');
const { WorkspaceFsBackends } = loadCompiled('workspaces/fs/workspace-fs-backends.service.js');
const { SshWorkspaceSessions } = loadCompiled('workspaces/fs/ssh-workspace-sessions.service.js');
const { buildWorkspaceExecEnv } = loadCompiled('workspaces/workspace-exec-env.js');
const { createLocalRemoteSession } = require('./lib/local-remote-session.cjs');
const mongoose = nm('mongoose');
const { HttpException } = nm('@nestjs/common');

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`ok  ${label}`); }
  catch (err) { failures += 1; console.error(`FAIL ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusOf = (e) => (e && typeof e.getStatus === 'function' ? e.getStatus() : undefined);
async function rejectsStatus(fn, status) {
  let e;
  try { await fn(); } catch (x) { e = x; }
  assert.ok(e instanceof HttpException, `expected HttpException, got ${e && e.stack}`);
  assert.equal(statusOf(e), status, JSON.stringify(e.getResponse()));
}
const OPTS = { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 };

let finishedRun = false;
process.on('exit', (code) => {
  if (!finishedRun && code === 0) {
    console.error('FAIL check run ended early (a pending promise never settled)');
    process.exitCode = 1;
  }
});

// ---- container fake ---------------------------------------------------------
/** Fake sidecar client: `script(emit, signal)` drives the NDJSON events of one call. */
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    ensureDir: async () => undefined,
    execStream: async (workspaceId, command, timeoutMs, env, abortSignal, onEvent) => {
      const call = { workspaceId, command, timeoutMs, env, abortSignal };
      calls.push(call);
      await script(onEvent, abortSignal, call);
    },
  };
}
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
/** Resolves when `signal` aborts, then throws like fetch does. */
const untilAborted = (signal) => new Promise((_, reject) => {
  if (signal.aborted) { reject(abortError()); return; }
  signal.addEventListener('abort', () => reject(abortError()), { once: true });
});

(async () => {
  // ---- env helper ---------------------------------------------------------------
  await check('buildWorkspaceExecEnv: git tokens + DG_*, caller env wins; nothing -> undefined', async () => {
    const ws = { _id: 'w1' };
    const git = { resolveForWorkspace: async (w) => { assert.equal(w, ws); return { GH_TOKEN: 'g', SHARED: 'git' }; } };
    const cli = { buildEnvFor: (w) => { assert.equal(w, ws); return { DG_API_TOKEN: 't', SHARED: 'dg' }; } };
    assert.deepEqual(await buildWorkspaceExecEnv(git, cli, ws), { GH_TOKEN: 'g', SHARED: 'dg', DG_API_TOKEN: 't' });
    assert.deepEqual(await buildWorkspaceExecEnv(git, cli, ws, { SHARED: 'caller', X: '1' }), { GH_TOKEN: 'g', SHARED: 'caller', DG_API_TOKEN: 't', X: '1' });
    const none = { resolveForWorkspace: async () => ({}) };
    const noneCli = { buildEnvFor: () => ({}) };
    assert.equal(await buildWorkspaceExecEnv(none, noneCli, ws), undefined);
    assert.deepEqual(await buildWorkspaceExecEnv(none, noneCli, ws, {}), {});
  });

  // ---- container ------------------------------------------------------------------
  await check('container: events mapped to exitCode/stdout/stderr; timeout passed to the sidecar', async () => {
    const client = fakeClient(async (emit) => {
      emit({ type: 'stdout', line: 'one' });
      emit({ type: 'stderr', line: 'warn' });
      emit({ type: 'stdout', line: 'two' });
      emit({ type: 'done', exitCode: 3, timedOut: false, killReason: null });
      emit({ type: 'cwd', cwd: '/workspaces/w' });
    });
    const b = new ContainerFsBackend(client, 'w1', async () => ({ GH_TOKEN: 'x' }));
    const res = await b.exec('make test', { timeoutMs: 90_000, maxOutputBytes: 1024 });
    assert.deepEqual(res, { exitCode: 3, stdout: 'one\ntwo', stderr: 'warn', truncated: false, timedOut: false, aborted: false });
    assert.equal(client.calls[0].workspaceId, 'w1');
    assert.equal(client.calls[0].command, 'make test');
    assert.equal(client.calls[0].timeoutMs, 90_000);
    assert.deepEqual(client.calls[0].env, { GH_TOKEN: 'x' });
  });

  await check('container: timeout capped at 600 s; sidecar timeout -> timedOut', async () => {
    const client = fakeClient(async (emit) => {
      emit({ type: 'stdout', line: 'partial' });
      emit({ type: 'done', exitCode: null, signal: 'SIGTERM', timedOut: true, killReason: 'timeout' });
    });
    const b = new ContainerFsBackend(client, 'w1', async () => undefined);
    const res = await b.exec('sleep 999', { timeoutMs: 900_000, maxOutputBytes: 1024 });
    assert.equal(client.calls[0].timeoutMs, 600_000);
    assert.equal(client.calls[0].env, undefined);
    assert.deepEqual(res, { exitCode: null, stdout: 'partial', stderr: '', truncated: false, timedOut: true, aborted: false });
  });

  await check('container: output capped per stream at maxOutputBytes (truncated); sidecar truncation flag kept', async () => {
    const client = fakeClient(async (emit) => {
      for (let i = 0; i < 50; i += 1) emit({ type: 'stdout', line: 'x'.repeat(10) });
      emit({ type: 'stderr', line: 'short' });
      emit({ type: 'done', exitCode: 0, timedOut: false });
    });
    const b = new ContainerFsBackend(client, 'w1', async () => undefined);
    const res = await b.exec('yes', { timeoutMs: 1000, maxOutputBytes: 100 });
    assert.equal(res.truncated, true);
    assert.ok(Buffer.byteLength(res.stdout) <= 100, `stdout ${Buffer.byteLength(res.stdout)} bytes`);
    assert.ok(res.stdout.startsWith('xxxxxxxxxx\nxxxxxxxxxx'));
    assert.equal(res.stderr, 'short');
    assert.equal(res.exitCode, 0);
    const flagged = fakeClient(async (emit) => {
      emit({ type: 'stdout', line: 'a' });
      emit({ type: 'truncated', stream: 'stdout' });
      emit({ type: 'done', exitCode: 0, timedOut: false, stdoutTruncated: true });
    });
    const res2 = await new ContainerFsBackend(flagged, 'w1', async () => undefined).exec('x', OPTS);
    assert.equal(res2.truncated, true);
  });

  await check('container: multi-byte output is cut on a character boundary', async () => {
    const client = fakeClient(async (emit) => {
      emit({ type: 'stdout', line: 'ä'.repeat(20) });
      emit({ type: 'done', exitCode: 0, timedOut: false });
    });
    const res = await new ContainerFsBackend(client, 'w1', async () => undefined).exec('x', { timeoutMs: 1000, maxOutputBytes: 7 });
    assert.equal(res.truncated, true);
    assert.equal(res.stdout, 'äää');
  });

  await check('container: abort via signal ends the upstream request; aborted, partial output kept', async () => {
    let seenSignal;
    const client = fakeClient(async (emit, signal) => {
      seenSignal = signal;
      emit({ type: 'stdout', line: 'started' });
      await untilAborted(signal);
    });
    const b = new ContainerFsBackend(client, 'w1', async () => undefined);
    const ac = new AbortController();
    const running = b.exec('sleep 100', { ...OPTS, signal: ac.signal });
    await sleep(20);
    ac.abort();
    const res = await running;
    assert.equal(seenSignal.aborted, true, 'upstream signal aborted');
    assert.deepEqual(res, { exitCode: null, stdout: 'started', stderr: '', truncated: false, timedOut: false, aborted: true });
  });

  await check('container: signal already aborted -> no sidecar call', async () => {
    const client = fakeClient(async () => { throw new Error('must not run'); });
    const ac = new AbortController();
    ac.abort();
    const res = await new ContainerFsBackend(client, 'w1', async () => undefined).exec('ls', { ...OPTS, signal: ac.signal });
    assert.equal(res.aborted, true);
    assert.equal(client.calls.length, 0);
  });

  await check('container: sidecar error (e.g. blacklist 400) propagates; stream error event -> stderr, exit null', async () => {
    const failing = fakeClient(async () => { throw new Error('sidecar 400 /exec/stream: command rejected by safety blacklist'); });
    await assert.rejects(new ContainerFsBackend(failing, 'w1', async () => undefined).exec('rm -rf /', OPTS), /blacklist/);
    const spawnErr = fakeClient(async (emit) => { emit({ type: 'error', message: 'spawn failed' }); });
    const res = await new ContainerFsBackend(spawnErr, 'w1', async () => undefined).exec('x', OPTS);
    assert.equal(res.exitCode, null);
    assert.match(res.stderr, /spawn failed/);
  });

  await check('container/ssh: empty or NUL command -> 400; nothing runs', async () => {
    const client = fakeClient(async () => { throw new Error('must not run'); });
    const b = new ContainerFsBackend(client, 'w1', async () => undefined);
    await rejectsStatus(() => b.exec('   ', OPTS), 400);
    await rejectsStatus(() => b.exec('ls\0', OPTS), 400);
    await rejectsStatus(() => b.exec('x'.repeat(8 * 1024 + 1), OPTS), 400);
    assert.equal(client.calls.length, 0);
  });

  await check('backends.for(container): exec env = git tokens + DG_* of that workspace', async () => {
    const client = fakeClient(async (emit) => emit({ type: 'done', exitCode: 0, timedOut: false }));
    const ws = { _id: new mongoose.Types.ObjectId(), projectId: new mongoose.Types.ObjectId(), status: 'active', location: 'container', name: 'w' };
    const git = { resolveForWorkspace: async (w) => { assert.equal(w, ws); return { GH_TOKEN: 'ghp_fake', GITLAB_TOKEN: 'glpat_fake' }; } };
    const cli = { buildEnvFor: (w) => { assert.equal(w, ws); return { DG_API_TOKEN: 'jwt', DG_WORKSPACE_ID: String(ws._id) }; } };
    const backends = new WorkspaceFsBackends(client, {}, {}, {}, {}, git, cli);
    const backend = await backends.for(ws);
    await backend.exec('gh pr list', OPTS);
    assert.deepEqual(client.calls[0].env, { GH_TOKEN: 'ghp_fake', GITLAB_TOKEN: 'glpat_fake', DG_API_TOKEN: 'jwt', DG_WORKSPACE_ID: String(ws._id) });
    assert.equal(client.calls[0].workspaceId, String(ws._id));
  });

  // ---- ssh --------------------------------------------------------------------------
  const tmpRoots = [];
  function setup(rootName = 'srv') {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-wsexec-'));
    tmpRoots.push(base);
    const root = path.join(base, rootName);
    fs.mkdirSync(root);
    const fake = createLocalRemoteSession(base, RemoteError);
    fake.switches.execScript = {};
    const runs = [];
    const audits = [];
    const run = (fn, o) => { runs.push(o || {}); return fn(fake.session); };
    const backend = new SshFsBackend(root, run, (action, p, extra) => audits.push({ action, path: p, ...(extra || {}) }), { uploadMaxBytes: 1024 });
    return { base, root, fake, backend, runs, audits };
  }

  await check('ssh: command is `cd -- <shq(root)> && <command>` (command unquoted); result mapped; not retryable; no env', async () => {
    const t = setup();
    t.fake.switches.execScript = { code: 2, stdout: 'out\n', stderr: 'err\n' };
    const res = await t.backend.exec('npm test -- --grep "a b"', { timeoutMs: 30_000, maxOutputBytes: 4096 });
    assert.deepEqual(res, { exitCode: 2, stdout: 'out\n', stderr: 'err\n', truncated: false, timedOut: false, aborted: false });
    assert.deepEqual(t.fake.calls.agentExecs, [`cd -- '${t.root}' && npm test -- --grep "a b"`]);
    const opts = t.fake.calls.execOpts[t.fake.calls.execOpts.length - 1];
    assert.equal(opts.timeoutMs, 30_000);
    assert.equal(opts.maxOutputBytes, 4096);
    assert.ok(!('env' in opts), 'no env toward the server');
    assert.notEqual(opts.terminateOnTimeout, false);
    assert.ok(t.runs.every((o) => o.retryable !== true), 'exec is not retryable');
  });

  await check("ssh: a root containing ' is quoted as one word", async () => {
    const t = setup("it's here");
    await t.backend.exec('ls', OPTS);
    const cmd = t.fake.calls.agentExecs[0];
    assert.ok(cmd.startsWith(`cd -- '${t.root.replace(/'/g, `'\\''`)}' && `), cmd);
    assert.ok(cmd.endsWith(' && ls'));
  });

  await check('ssh: agent command never runs in the fake (no file created)', async () => {
    const t = setup();
    await t.backend.exec('touch pwned && echo hi > pwned2', OPTS);
    assert.deepEqual(fs.readdirSync(t.root), []);
    assert.equal(t.fake.calls.agentExecs.length, 1);
  });

  await check('ssh: no `timeout` wrapper around agent commands even when the server has it', async () => {
    const t = setup();
    t.fake.switches.probeTimeout = true;
    await t.backend.exec('sleep 1', OPTS);
    assert.ok(!/&& timeout /.test(t.fake.calls.agentExecs[0]), t.fake.calls.agentExecs[0]);
  });

  await check('ssh: exec timeout -> timedOut, partial output kept, exit null', async () => {
    const t = setup();
    t.fake.switches.execScript = { stdout: 'so far', timeout: true, delayMs: 5 };
    const res = await t.backend.exec('sleep 100', { timeoutMs: 50, maxOutputBytes: 1024 });
    assert.deepEqual(res, { exitCode: null, stdout: 'so far', stderr: '', truncated: false, timedOut: true, aborted: false });
  });

  await check('ssh: signal abort -> aborted; signal reached the session exec', async () => {
    const t = setup();
    t.fake.switches.execScript = { stdout: 'begun', delayMs: 10_000 };
    const ac = new AbortController();
    const running = t.backend.exec('sleep 100', { ...OPTS, signal: ac.signal });
    await sleep(20);
    ac.abort();
    const res = await running;
    assert.equal(t.fake.calls.aborts, 1);
    assert.equal(t.fake.calls.execOpts[t.fake.calls.execOpts.length - 1].signal, ac.signal);
    assert.deepEqual(res, { exitCode: null, stdout: 'begun', stderr: '', truncated: false, timedOut: false, aborted: true });
  });

  await check('ssh: output over maxOutputBytes -> truncated', async () => {
    const t = setup();
    t.fake.switches.execScript = { stdout: 'y'.repeat(500) };
    const res = await t.backend.exec('yes', { timeoutMs: 1000, maxOutputBytes: 100 });
    assert.equal(res.truncated, true);
    assert.equal(res.stdout.length, 100);
  });

  await check('ssh: audit row "exec" with command and exit code, also on timeout', async () => {
    const t = setup();
    t.fake.switches.execScript = { code: 1 };
    await t.backend.exec('make', OPTS);
    t.fake.switches.execScript = { timeout: true };
    await t.backend.exec('make slow', OPTS);
    assert.equal(t.audits.length, 2);
    assert.equal(t.audits[0].action, 'exec');
    assert.equal(t.audits[0].path, t.root);
    assert.equal(t.audits[0].command, 'make');
    assert.equal(t.audits[0].exitCode, 1);
    assert.equal(t.audits[1].command, 'make slow');
    assert.match(t.audits[1].errorMsg, /timeout/i);
  });

  await check('ssh: remote errors other than timeout/abort -> IDE HttpException (disconnected 502)', async () => {
    const t = setup();
    const b = new SshFsBackend(t.root, async () => { throw new RemoteError('disconnected', 'gone'); }, () => undefined, { uploadMaxBytes: 1 });
    await rejectsStatus(() => b.exec('ls', OPTS), 502);
  });

  await check('fake: agent shape only while execScript is set; root outside the temp dir throws', async () => {
    const t = setup();
    t.fake.switches.execScript = null;
    await assert.rejects(t.fake.session.exec(`cd -- '${t.root}' && touch x`, {}), /not allowed/);
    t.fake.switches.execScript = {};
    await assert.rejects(t.fake.session.exec(`cd -- '/etc' && ls`, {}), /outside the temp dir/);
    assert.deepEqual(fs.readdirSync(t.root), []);
  });

  // ---- sessions wrapper ---------------------------------------------------------
  function sessionsWorld() {
    const w = { execs: [], execOpts: [], pending: [] };
    const connector = {
      connect: async () => {
        const client = new EventEmitter();
        client.end = () => {};
        client.destroy = () => {};
        return client;
      },
    };
    const factory = async () => ({
      fs: {},
      close() {},
      exec: (command, opts) => {
        w.execs.push(command);
        w.execOpts.push(opts);
        return new Promise((resolve, reject) => {
          w.pending.push(() => resolve({ code: 0, stdout: '', stderr: '', truncated: false }));
          if (opts.signal) opts.signal.addEventListener('abort', () => reject(new RemoteError('aborted', 'exec aborted')), { once: true });
        });
      },
    });
    w.svc = new SshWorkspaceSessions(connector, { findById: async () => ({ label: 'x' }) }, factory);
    return w;
  }

  await check('sessions: signal passed to the driver; aborted exec keeps the session', async () => {
    const w = sessionsWorld();
    const ac = new AbortController();
    const running = w.svc.withSession('ws1', 'c1', (s) => s.exec('long', { signal: ac.signal }));
    await sleep(20);
    assert.equal(w.execOpts[0].signal, ac.signal);
    ac.abort();
    await assert.rejects(running, (e) => e instanceof RemoteError && e.code === 'aborted');
    // Same session still usable.
    const next = w.svc.withSession('ws1', 'c1', (s) => s.exec('short'));
    await sleep(10);
    w.pending[w.pending.length - 1]();
    await next;
    w.svc.onModuleDestroy();
  });

  await check('sessions: abort while waiting for an exec slot -> rejected, never sent to the driver', async () => {
    const w = sessionsWorld();
    const a = w.svc.withSession('ws1', 'c1', (s) => s.exec('a'));
    const b = w.svc.withSession('ws1', 'c1', (s) => s.exec('b'));
    await sleep(20);
    assert.equal(w.execs.length, 2);
    const ac = new AbortController();
    const queued = w.svc.withSession('ws1', 'c1', (s) => s.exec('queued', { signal: ac.signal }));
    await sleep(10);
    ac.abort();
    await assert.rejects(queued, (e) => e instanceof RemoteError && e.code === 'aborted');
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(w.svc.withSession('ws1', 'c1', (s) => s.exec('pre', { signal: pre.signal })), (e) => e instanceof RemoteError && e.code === 'aborted');
    // The freed slots go to the next waiter, not to the aborted one.
    const c = w.svc.withSession('ws1', 'c1', (s) => s.exec('c'));
    w.pending[0]();
    await a;
    await sleep(10);
    assert.deepEqual(w.execs, ['a', 'b', 'c']);
    w.pending[1]();
    w.pending[2]();
    await Promise.all([b, c]);
    w.svc.onModuleDestroy();
  });

  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
  finishedRun = true;
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
})();
