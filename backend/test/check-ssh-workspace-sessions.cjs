#!/usr/bin/env node
/*
 * Held SSH session per workspace (Task 5): shared connect, exec cap, retry,
 * idle close, stream activity, drop hooks, connect-error mapping, probe.
 *
 * Loads from dist/; run `npm run build` first. No database, no network: the
 * connector and the ssh2 driver factory are fakes.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}
const nm = (m) => require(path.resolve(__dirname, '..', 'node_modules', m));

const { RemoteError, parseProbeOutput, PROBE_COMMAND } = loadCompiled('workspaces/fs/remote-session.js');
const { SshWorkspaceSessions } = loadCompiled('workspaces/fs/ssh-workspace-sessions.service.js');
const { createSsh2Driver, toRemoteError } = loadCompiled('workspaces/fs/ssh2-remote-session.js');
const { SshConnectionChangeListener } =loadCompiled('workspaces/ssh-connection-change.listener.js');
const { SSH_CONNECTION_CHANGED } = loadCompiled('ssh/ssh-events.js');
const { SshService } = loadCompiled('ssh/ssh.service.js');
const { WorkspacesService } = loadCompiled('workspaces/workspaces.service.js');
const { EVENT_LISTENER_METADATA } = nm('@nestjs/event-emitter/dist/constants');
const { HttpException } = nm('@nestjs/common');

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusOf = (e) => (typeof e.getStatus === 'function' ? e.getStatus() : e.status);
async function rejection(fn) {
  try { await fn(); } catch (e) { return e; }
  throw new Error('expected a rejection');
}

// ---- fakes -------------------------------------------------------------------

/**
 * World: a fake connector (counts connects, returns EventEmitter clients) and
 * a fake driver factory. `world.behave(n)` customises the n-th driver (1-based).
 */
function makeWorld() {
  const w = {
    connects: 0,
    clients: [],
    drivers: [],
    connectDelayMs: 10,
    connectError: null,
    execDelayMs: 20,
    execActive: 0,
    execMax: 0,
    execOrder: [],
    stat: [], // per driver index: (p) => Promise
    readFile: [], // per driver index: (p, maxBytes) => Promise
    execImpl: [], // per driver index: (command, opts) => Promise
    factoryHang: false,
  };
  w.connector = {
    connect: async (connId) => {
      w.connects += 1;
      await sleep(w.connectDelayMs);
      if (w.connectError) throw w.connectError;
      const client = new EventEmitter();
      client.connId = connId;
      client.ended = 0;
      client.end = () => { client.ended += 1; };
      client.destroy = () => {};
      w.clients.push(client);
      return client;
    },
  };
  w.factory = async (client, ctx) => {
    if (w.factoryHang) return new Promise(() => {});
    const idx = w.drivers.length;
    const driver = {
      client,
      ctx,
      closed: 0,
      close() { driver.closed += 1; },
      execs: [],
      fs: {
        stat: (p) => (w.stat[idx] ? w.stat[idx](p) : Promise.resolve({ size: 1, mode: 0o100644, uid: 0, isFile: true, isDirectory: false, isSymlink: false })),
        createReadStream: () => { const s = new PassThrough(); driver.lastStream = s; return s; },
        readdir: async () => [],
        readFile: (p, max) => (w.readFile[idx] ? w.readFile[idx](p, max) : Promise.resolve(Buffer.from('x'))),
      },
      execOpts: [],
      exec: async (command, opts) => {
        driver.execs.push(command);
        driver.execOpts.push(opts);
        if (w.execImpl[idx] && !command.includes('command -v rg')) return w.execImpl[idx](command, opts);
        if (command.includes('command -v rg')) {
          return { code: 0, stdout: 'rg=1\ngit=0\ntimeout=1\nuid=1001\ngid=1002\n', stderr: '', truncated: false };
        }
        w.execActive += 1;
        w.execMax = Math.max(w.execMax, w.execActive);
        w.execOrder.push(command);
        await sleep(w.execDelayMs);
        w.execActive -= 1;
        return { code: 0, stdout: command, stderr: '', truncated: false };
      },
    };
    w.drivers.push(driver);
    return driver;
  };
  w.ssh = { findById: async () => ({ label: 'prod' }) };
  w.svc = () => new SshWorkspaceSessions(w.connector, w.ssh, w.factory);
  return w;
}

(async () => {
  await check('5 parallel withSession -> exactly 1 connect', async () => {
    const w = makeWorld();
    const svc = w.svc();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => svc.withSession('ws1', 'c1', async () => i)),
    );
    assert.deepEqual(results, [0, 1, 2, 3, 4]);
    assert.equal(w.connects, 1);
    svc.onModuleDestroy();
  });

  await check('4 parallel exec -> never more than 2 active, FIFO order', async () => {
    const w = makeWorld();
    const svc = w.svc();
    const out = await Promise.all(
      ['a', 'b', 'c', 'd'].map((c) => svc.withSession('ws1', 'c1', (s) => s.exec(c))),
    );
    assert.deepEqual(out.map((r) => r.stdout), ['a', 'b', 'c', 'd']);
    assert.equal(w.execMax, 2);
    assert.deepEqual(w.execOrder, ['a', 'b', 'c', 'd']);
    svc.onModuleDestroy();
  });

  await check('retryable op: disconnected -> second connect, result arrives', async () => {
    const w = makeWorld();
    w.stat[0] = async () => { throw new RemoteError('disconnected', 'gone'); };
    const svc = w.svc();
    const st = await svc.withSession('ws1', 'c1', (s) => s.fs.stat('/x'), { retryable: true });
    assert.equal(st.size, 1);
    assert.equal(w.connects, 2);
    assert.equal(w.clients[0].ended >= 1, true, 'first client closed');
    svc.onModuleDestroy();
  });

  await check('retryable op: timeout -> retried once; second failure surfaces', async () => {
    const w = makeWorld();
    let attempts = 0;
    w.stat[0] = async () => { attempts += 1; throw new RemoteError('timeout', 't'); };
    w.stat[1] = async () => { attempts += 1; throw new RemoteError('timeout', 't'); };
    w.stat[2] = async () => { attempts += 1; return {}; };
    const svc = w.svc();
    const err = await rejection(() => svc.withSession('ws1', 'c1', (s) => s.fs.stat('/x'), { retryable: true }));
    assert.equal(err.code, 'timeout');
    assert.equal(attempts, 2);
    assert.equal(w.connects, 2);
    svc.onModuleDestroy();
  });

  await check('non-retryable op: disconnected -> error, no second attempt', async () => {
    const w = makeWorld();
    let attempts = 0;
    w.stat[0] = async () => { attempts += 1; throw new RemoteError('disconnected', 'gone'); };
    const svc = w.svc();
    const err = await rejection(() => svc.withSession('ws1', 'c1', (s) => s.fs.stat('/x')));
    assert.ok(err instanceof RemoteError);
    assert.equal(err.code, 'disconnected');
    assert.equal(attempts, 1);
    assert.equal(w.connects, 1);
    svc.onModuleDestroy();
  });

  await check('retryable op: not_found is not retried', async () => {
    const w = makeWorld();
    let attempts = 0;
    w.stat[0] = async () => { attempts += 1; throw new RemoteError('not_found', 'nope'); };
    const svc = w.svc();
    const err = await rejection(() => svc.withSession('ws1', 'c1', (s) => s.fs.stat('/x'), { retryable: true }));
    assert.equal(err.code, 'not_found');
    assert.equal(attempts, 1);
    assert.equal(w.connects, 1);
    assert.equal(w.clients[0].ended, 0, 'session kept');
    svc.onModuleDestroy();
  });

  await check('retryable op: client close during the op -> retried with a fresh session', async () => {
    const w = makeWorld();
    w.stat[0] = () => new Promise((_, reject) => {
      setTimeout(() => {
        w.clients[0].emit('close');
        reject(new Error('raw ssh2 failure'));
      }, 5);
    });
    const svc = w.svc();
    const st = await svc.withSession('ws1', 'c1', (s) => s.fs.stat('/x'), { retryable: true });
    assert.equal(st.size, 1);
    assert.equal(w.connects, 2);
    svc.onModuleDestroy();
  });

  await check('single fs op over the op timeout -> RemoteError timeout, session dropped', async () => {
    const w = makeWorld();
    w.stat[0] = () => new Promise(() => {});
    const svc = w.svc();
    svc.opTimeoutMs = 30;
    const err = await rejection(() => svc.withSession('ws1', 'c1', (s) => s.fs.stat('/x')));
    assert.equal(err.code, 'timeout');
    assert.equal(w.clients[0].ended >= 1, true);
    svc.onModuleDestroy();
  });

  await check('idle -> client end(); next call connects again', async () => {
    const w = makeWorld();
    const svc = w.svc();
    svc.idleMs = 30;
    await svc.withSession('ws1', 'c1', async () => 1);
    assert.equal(w.clients[0].ended, 0);
    await sleep(80);
    assert.equal(w.clients[0].ended >= 1, true);
    assert.equal(w.drivers[0].closed >= 1, true);
    await svc.withSession('ws1', 'c1', async () => 2);
    assert.equal(w.connects, 2);
    svc.onModuleDestroy();
  });

  await check('in-flight op keeps the session past the idle timeout', async () => {
    const w = makeWorld();
    const svc = w.svc();
    svc.idleMs = 20;
    await svc.withSession('ws1', 'c1', () => sleep(70));
    assert.equal(w.clients[0].ended, 0);
    await sleep(60);
    assert.equal(w.clients[0].ended >= 1, true);
    svc.onModuleDestroy();
  });

  await check('read stream keeps the session alive until it closes', async () => {
    const w = makeWorld();
    const svc = w.svc();
    svc.idleMs = 30;
    const stream = await svc.withSession('ws1', 'c1', async (s) => s.fs.createReadStream('/big'));
    await sleep(90);
    assert.equal(w.clients[0].ended, 0, 'open stream counts as activity');
    stream.destroy();
    await sleep(80);
    assert.equal(w.clients[0].ended >= 1, true, 'idle after stream close');
    svc.onModuleDestroy();
  });

  await check('dropByConnection closes all sessions of that connection only', async () => {
    const w = makeWorld();
    const svc = w.svc();
    await svc.withSession('ws1', 'cA', async () => 1);
    await svc.withSession('ws2', 'cA', async () => 1);
    await svc.withSession('ws3', 'cB', async () => 1);
    svc.dropByConnection('cA');
    const byConn = (id) => w.clients.filter((c) => c.connId === id);
    assert.ok(byConn('cA').every((c) => c.ended >= 1));
    assert.ok(byConn('cB').every((c) => c.ended === 0));
    await svc.withSession('ws3', 'cB', async () => 1);
    assert.equal(w.connects, 3);
    svc.onModuleDestroy();
  });

  await check('drop(workspaceId) closes the session; a changed connection id reconnects', async () => {
    const w = makeWorld();
    const svc = w.svc();
    await svc.withSession('ws1', 'cA', async () => 1);
    svc.drop('ws1');
    assert.equal(w.clients[0].ended >= 1, true);
    await svc.withSession('ws1', 'cA', async () => 1);
    await svc.withSession('ws1', 'cB', async () => 1);
    assert.equal(w.connects, 3);
    assert.equal(w.clients[1].ended >= 1, true);
    svc.onModuleDestroy();
  });

  await check('onModuleDestroy closes every session', async () => {
    const w = makeWorld();
    const svc = w.svc();
    await svc.withSession('ws1', 'cA', async () => 1);
    await svc.withSession('ws2', 'cB', async () => 1);
    svc.onModuleDestroy();
    assert.ok(w.clients.every((c) => c.ended >= 1));
  });

  const connectCases = [
    [new Error('tofu_not_accepted'), 409, /Fingerprint nicht akzeptiert/],
    [new Error('host_key_mismatch'), 409, /prod/],
    [new Error('credential_missing'), 409, /prod/],
    [Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }), 409, /prod/],
    [Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:22'), { code: 'ECONNREFUSED' }), 502, /prod/],
    [Object.assign(new Error('Timed out while waiting for handshake'), { level: 'client-timeout' }), 504, /prod/],
  ];
  for (const [cause, status, re] of connectCases) {
    await check(`connect error "${cause.message}" -> HttpException ${status}`, async () => {
      const w = makeWorld();
      w.connectError = cause;
      const svc = w.svc();
      const err = await rejection(() => svc.withSession('ws1', 'c1', async () => 1, { retryable: true }));
      assert.ok(err instanceof HttpException, `got ${err && err.constructor && err.constructor.name}`);
      assert.equal(statusOf(err), status);
      assert.match(err.message, re);
      assert.match(err.message, /SSH-Verbindung "prod"/);
      const body = err.getResponse();
      assert.equal(typeof body.error, 'string');
      assert.equal(typeof body.message, 'string');
      assert.equal(w.connects, 1, 'connect errors are not retried');
      // A failed connect is not memoised.
      w.connectError = null;
      await svc.withSession('ws1', 'c1', async () => 1);
      assert.equal(w.connects, 2);
      svc.onModuleDestroy();
    });
  }

  await check('concurrent first calls share one failing connect', async () => {
    const w = makeWorld();
    w.connectError = new Error('tofu_not_accepted');
    const svc = w.svc();
    const errs = await Promise.all([1, 2, 3].map(() => rejection(() => svc.withSession('ws1', 'c1', async () => 1))));
    assert.ok(errs.every((e) => statusOf(e) === 409));
    assert.equal(w.connects, 1);
  });

  await check('probe runs once per session and parses rg/git/uid', async () => {
    const w = makeWorld();
    const svc = w.svc();
    const a = await svc.withSession('ws1', 'c1', (s) => s.probe());
    const b = await svc.withSession('ws1', 'c1', (s) => s.probe());
    assert.deepEqual(a, { rg: true, git: false, timeout: true, uid: 1001, gid: 1002 });
    assert.deepEqual(b, a);
    assert.equal(w.drivers[0].execs.filter((c) => c.includes('command -v rg')).length, 1);
    svc.onModuleDestroy();
  });

  await check('PROBE_COMMAND: one exec; probes timeout too; runs in a real sh and parses', () => {
    // Usability, not presence: old busybox `timeout` wants `-t SECS` and fails here.
    assert.ok(PROBE_COMMAND.includes('timeout 1 true >/dev/null 2>&1 && echo timeout=1 || echo timeout=0'));
    const out = execFileSync('sh', ['-c', PROBE_COMMAND], { encoding: 'utf8' });
    const p = parseProbeOutput(out);
    assert.equal(typeof p.timeout, 'boolean');
    assert.equal(p.uid, process.getuid());
    // Same PATH as above: `timeout` is coreutils and present locally.
    assert.equal(p.timeout, true);
    const noTimeout = execFileSync('/bin/sh', ['-c', PROBE_COMMAND], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    assert.equal(parseProbeOutput(noTimeout).timeout, false);
  });

  await check('PROBE_COMMAND: old busybox `timeout` (-t SECS syntax) -> timeout=0; a working one -> timeout=1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-probe-'));
    try {
      const sh = execFileSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).trim();
      // Old busybox: `timeout [-t SECS] [-s SIG] PROG ARGS` — `timeout 1 true` runs "1".
      fs.writeFileSync(path.join(dir, 'timeout'), `#!${sh}\nwhile [ "$#" -gt 0 ]; do case "$1" in -t|-s) shift 2;; *) break;; esac; done\nexec "$@"\n`, { mode: 0o755 });
      const env = { PATH: `${dir}:/usr/bin:/bin` };
      const old = parseProbeOutput(execFileSync(sh, ['-c', PROBE_COMMAND], { encoding: 'utf8', env }));
      assert.equal(old.timeout, false, 'unusable busybox timeout');
      fs.writeFileSync(path.join(dir, 'timeout'), `#!${sh}\nshift\nexec "$@"\n`, { mode: 0o755 });
      const ok = parseProbeOutput(execFileSync(sh, ['-c', PROBE_COMMAND], { encoding: 'utf8', env }));
      assert.equal(ok.timeout, true, 'usable timeout');
      assert.equal(ok.uid, process.getuid());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('exec: terminateOnTimeout passed to the driver (default true, false kept)', async () => {
    const w = makeWorld();
    const svc = w.svc();
    await svc.withSession('ws1', 'c1', (s) => s.exec('a'));
    await svc.withSession('ws1', 'c1', (s) => s.exec('b', { terminateOnTimeout: false }));
    const opts = w.drivers[0].execOpts;
    assert.equal(opts[0].terminateOnTimeout, true);
    assert.equal(opts[1].terminateOnTimeout, false);
    svc.onModuleDestroy();
  });

  await check('exec: outputMode passed to the driver (default stop, headTail kept)', async () => {
    const w = makeWorld();
    const svc = w.svc();
    await svc.withSession('ws1', 'c1', (s) => s.exec('a'));
    await svc.withSession('ws1', 'c1', (s) => s.exec('b', { outputMode: 'headTail' }));
    await svc.withSession('ws1', 'c1', (s) => s.exec('c', { outputMode: 'bogus' }));
    assert.deepEqual(w.drivers[0].execOpts.map((o) => o.outputMode), ['stop', 'headTail', 'stop']);
    svc.onModuleDestroy();
  });

  await check('parseProbeOutput tolerates noise and missing values', () => {
    assert.deepEqual(parseProbeOutput('motd line\r\nrg=0\r\ngit=1\r\ntimeout=1\r\nuid=0\r\ngid=50\r\n'), { rg: false, git: true, timeout: true, uid: 0, gid: 50 });
    assert.deepEqual(parseProbeOutput(''), { rg: false, git: false, timeout: false, uid: -1, gid: -1 });
    assert.deepEqual(parseProbeOutput('uid=abc\ntimeout=yes\n'), { rg: false, git: false, timeout: false, uid: -1, gid: -1 });
  });

  // ---- R7: timeouts that scale, SFTP-open timeout, exec timeout keeps session --

  await check('readFile timeout scales with the stat size, not with maxBytes', async () => {
    const w = makeWorld();
    w.readFile[0] = () => new Promise(() => {});
    const svc = w.svc();
    svc.opTimeoutMs = 30;
    const res = await Promise.race([
      rejection(() => svc.withSession('ws1', 'c1', (s) => s.fs.readFile('/x', 100 * 1024 * 1024))),
      sleep(1500).then(() => 'hung'),
    ]);
    assert.notEqual(res, 'hung', 'timeout derived from maxBytes (100 MiB) instead of the 1-byte file');
    assert.equal(res.code, 'timeout');
    svc.onModuleDestroy();
  });

  await check('SFTP open (driver factory) never answering -> timeout, client ended', async () => {
    const w = makeWorld();
    w.factoryHang = true;
    const svc = w.svc();
    svc.opTimeoutMs = 30;
    const res = await Promise.race([
      rejection(() => svc.withSession('ws1', 'c1', async () => 1)),
      sleep(1500).then(() => 'hung'),
    ]);
    assert.notEqual(res, 'hung');
    assert.equal(res.code, 'timeout');
    assert.ok(w.clients[0].ended >= 1);
    svc.onModuleDestroy();
  });

  await check('exec timeout (driver) -> RemoteError timeout; session and parallel stream survive', async () => {
    const w = makeWorld();
    w.execImpl[0] = async () => { await sleep(5); throw new RemoteError('timeout', 'exec timed out'); };
    const svc = w.svc();
    const stream = await svc.withSession('ws1', 'c1', async (s) => s.fs.createReadStream('/big'));
    const err = await rejection(() => svc.withSession('ws1', 'c1', (s) => s.exec('slow')));
    assert.equal(err.code, 'timeout');
    assert.equal(w.clients[0].ended, 0, 'session kept');
    assert.equal(stream.destroyed, false, 'parallel download not killed');
    assert.equal(w.connects, 1);
    stream.destroy();
    svc.onModuleDestroy();
  });

  await check('exec hanging past its timeout + grace -> timeout, session kept, slots freed', async () => {
    const w = makeWorld();
    let n = 0;
    w.execImpl[0] = (command) => { n += 1; return command === 'ok' ? Promise.resolve({ code: 0, stdout: 'ok', stderr: '', truncated: false }) : new Promise(() => {}); };
    const svc = w.svc();
    svc.execGraceMs = 10;
    const errs = await Promise.all(['h1', 'h2'].map((c) => rejection(() => svc.withSession('ws1', 'c1', (s) => s.exec(c, { timeoutMs: 20 })))));
    assert.ok(errs.every((e) => e.code === 'timeout'));
    const ok = await Promise.race([svc.withSession('ws1', 'c1', (s) => s.exec('ok')), sleep(500).then(() => 'blocked')]);
    assert.notEqual(ok, 'blocked', 'exec slots freed after timeouts');
    assert.equal(ok.stdout, 'ok');
    assert.equal(w.clients[0].ended, 0);
    assert.equal(n, 3);
    svc.onModuleDestroy();
  });

  await check('SFTP single-op timeout still drops the session', async () => {
    const w = makeWorld();
    w.stat[0] = () => new Promise(() => {});
    const svc = w.svc();
    svc.opTimeoutMs = 20;
    await rejection(() => svc.withSession('ws1', 'c1', (s) => s.fs.stat('/x')));
    assert.ok(w.clients[0].ended >= 1);
    svc.onModuleDestroy();
  });

  await check('onConnect fires once per newly opened session, not on reuse or failed connect', async () => {
    const w = makeWorld();
    const svc = w.svc();
    let n = 0;
    const onConnect = () => { n += 1; };
    await Promise.all([1, 2, 3].map(() => svc.withSession('ws1', 'c1', async () => 1, { onConnect })));
    await svc.withSession('ws1', 'c1', async () => 1, { onConnect });
    assert.equal(n, 1);
    svc.drop('ws1');
    await svc.withSession('ws1', 'c1', async () => 1, { onConnect });
    assert.equal(n, 2);
    svc.drop('ws1');
    w.connectError = new Error('tofu_not_accepted');
    await rejection(() => svc.withSession('ws1', 'c1', async () => 1, { onConnect }));
    assert.equal(n, 2);
    svc.onModuleDestroy();
  });

  await check('drop during connect -> disconnected, client ended', async () => {
    const w = makeWorld();
    w.connectDelayMs = 40;
    const svc = w.svc();
    const pending = rejection(() => svc.withSession('ws1', 'c1', async () => 1));
    await sleep(5);
    svc.drop('ws1');
    const err = await pending;
    assert.equal(err.code, 'disconnected');
    assert.ok(w.clients[0].ended >= 1);
    svc.onModuleDestroy();
  });

  await check('stream erroring before close releases its ref (idle close follows)', async () => {
    const w = makeWorld();
    const svc = w.svc();
    svc.idleMs = 30;
    const stream = await svc.withSession('ws1', 'c1', async (s) => s.fs.createReadStream('/big'));
    stream.on('error', () => undefined);
    stream.emit('error', new Error('boom'));
    await sleep(80);
    assert.ok(w.clients[0].ended >= 1, 'session idle-closed after the stream error');
    svc.onModuleDestroy();
  });

  // ---- ssh2 driver (fake ssh2 client, no network) ---------------------------

  const sftpErr = (code, msg = 'sftp error') => Object.assign(new Error(msg), { code });
  const fakeStats = (over = {}) => ({
    size: 3, mode: 0o100644, uid: 7, gid: 8,
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
    ...over,
  });
  function makeSsh2(over = {}) {
    const sftp = new EventEmitter();
    sftp.ended = 0;
    sftp.end = () => { sftp.ended += 1; };
    sftp.existing = new Set();
    sftp.stat = (p, cb) => (sftp.existing.has(p) ? cb(undefined, fakeStats()) : cb(sftpErr(2, 'No such file')));
    sftp.lstat = sftp.stat;
    sftp.rename = (_a, _b, cb) => cb();
    sftp.mkdir = (p, cb) => (sftp.existing.has(p) ? cb(sftpErr(4, 'Failure')) : cb());
    sftp.ext_openssh_rename = () => { throw new Error('Server does not support this extended request'); };
    Object.assign(sftp, over);
    const client = new EventEmitter();
    client.sftp = (cb) => cb(undefined, sftp);
    client.execImpl = null;
    client.exec = (cmd, cb) => client.execImpl(cmd, cb);
    return { client, sftp };
  }
  function fakeChannel() {
    const ch = new EventEmitter();
    ch.stderr = new EventEmitter();
    ch.closed = 0;
    ch.close = () => { ch.closed += 1; setImmediate(() => ch.emit('close')); };
    ch.signals = [];
    ch.signal = (name) => { ch.signals.push({ name, closedBefore: ch.closed }); return true; };
    return ch;
  }

  await check('toRemoteError maps SFTP status codes and lost connections', () => {
    assert.equal(toRemoteError(sftpErr(2), 'x').code, 'not_found');
    assert.equal(toRemoteError(sftpErr(3), 'x').code, 'denied');
    assert.equal(toRemoteError(sftpErr(7), 'x').code, 'disconnected');
    assert.equal(toRemoteError(new Error('No response from server'), 'x').code, 'disconnected');
    assert.equal(toRemoteError(sftpErr(4), 'x').code, 'failure');
  });

  await check('driver: stat maps fields; missing file -> not_found', async () => {
    const { client, sftp } = makeSsh2();
    sftp.existing.add('/a');
    const d = await createSsh2Driver(client, { onLost() {} });
    assert.deepEqual(await d.fs.stat('/a'), { size: 3, mode: 0o100644, uid: 7, gid: 8, isFile: true, isDirectory: false, isSymlink: false });
    assert.equal((await rejection(() => d.fs.stat('/nope'))).code, 'not_found');
  });

  await check('driver: posixRename false without the extension, true with it', async () => {
    const a = makeSsh2();
    const d1 = await createSsh2Driver(a.client, { onLost() {} });
    assert.equal(await d1.fs.posixRename('/a', '/b'), false);
    const b = makeSsh2({ ext_openssh_rename: (_x, _y, cb) => cb() });
    const d2 = await createSsh2Driver(b.client, { onLost() {} });
    assert.equal(await d2.fs.posixRename('/a', '/b'), true);
  });

  await check('driver: rename onto an existing target -> exists, rename not called', async () => {
    let renamed = 0;
    const { client, sftp } = makeSsh2({ rename: (_a, _b, cb) => { renamed += 1; cb(); } });
    sftp.existing.add('/b');
    const d = await createSsh2Driver(client, { onLost() {} });
    assert.equal((await rejection(() => d.fs.rename('/a', '/b'))).code, 'exists');
    assert.equal(renamed, 0);
    await d.fs.rename('/a', '/c');
    assert.equal(renamed, 1);
  });

  await check('driver: rename pre-check propagates lstat errors other than not_found', async () => {
    let renamed = 0;
    const { client } = makeSsh2({
      rename: (_a, _b, cb) => { renamed += 1; cb(); },
      lstat: (_p, cb) => cb(sftpErr(3, 'Permission denied')),
    });
    const d = await createSsh2Driver(client, { onLost() {} });
    assert.equal((await rejection(() => d.fs.rename('/a', '/b'))).code, 'denied');
    assert.equal(renamed, 0);
  });

  await check('driver: mkdir FAILURE on an existing path -> exists', async () => {
    const { client, sftp } = makeSsh2();
    sftp.existing.add('/d');
    const d = await createSsh2Driver(client, { onLost() {} });
    assert.equal((await rejection(() => d.fs.mkdir('/d'))).code, 'exists');
    await d.fs.mkdir('/e');
  });

  await check('driver: readFile above maxBytes -> too_large', async () => {
    const { client, sftp } = makeSsh2();
    sftp.existing.add('/big');
    const d = await createSsh2Driver(client, { onLost() {} });
    assert.equal((await rejection(() => d.fs.readFile('/big', 2))).code, 'too_large');
  });

  await check('driver: SFTP channel close reports loss; close() ends the channel', async () => {
    const { client, sftp } = makeSsh2();
    const lost = [];
    const d = await createSsh2Driver(client, { onLost: (e) => lost.push(e) });
    sftp.emit('close');
    assert.equal(lost.length, 1);
    d.close();
    assert.equal(sftp.ended, 1);
  });

  await check('driver: exec collects output and exit code', async () => {
    const { client } = makeSsh2();
    client.execImpl = (_cmd, cb) => {
      const ch = fakeChannel();
      cb(undefined, ch);
      ch.emit('data', Buffer.from('out'));
      ch.stderr.emit('data', Buffer.from('err'));
      ch.emit('exit', 3);
      ch.emit('close');
    };
    const d = await createSsh2Driver(client, { onLost() {} });
    assert.deepEqual(await d.exec('x', { timeoutMs: 1000, maxOutputBytes: 100 }), { code: 3, stdout: 'out', stderr: 'err', truncated: false });
  });

  await check('driver: exec output over the cap -> truncated, channel closed', async () => {
    const { client } = makeSsh2();
    let chan;
    client.execImpl = (_cmd, cb) => { chan = fakeChannel(); cb(undefined, chan); chan.emit('data', Buffer.from('0123456789')); };
    const d = await createSsh2Driver(client, { onLost() {} });
    const r = await d.exec('x', { timeoutMs: 1000, maxOutputBytes: 4 });
    assert.equal(r.truncated, true);
    assert.equal(r.stdout, '0123');
    assert.ok(chan.closed >= 1);
  });

  await check('driver: headTail -> 3 MiB output keeps head + last line, no TERM, channel not closed, exit code kept', async () => {
    const { client } = makeSsh2();
    let chan;
    client.execImpl = (_cmd, cb) => {
      chan = fakeChannel();
      cb(undefined, chan);
      chan.emit('data', Buffer.from('FIRST\n'));
      for (let i = 0; i < 48; i += 1) chan.emit('data', Buffer.alloc(64 * 1024, 'z'));
      chan.emit('data', Buffer.from('\nLAST-LINE\n'));
      chan.stderr.emit('data', Buffer.from('warn'));
      chan.emit('exit', 0);
      chan.emit('close');
    };
    const d = await createSsh2Driver(client, { onLost() {} });
    const r = await d.exec('x', { timeoutMs: 1000, maxOutputBytes: 32 * 1024, terminateOnTimeout: true, outputMode: 'headTail' });
    assert.equal(r.code, 0);
    assert.equal(r.truncated, true);
    assert.ok(Buffer.byteLength(r.stdout) <= 32 * 1024);
    assert.ok(r.stdout.startsWith('FIRST\n') && r.stdout.endsWith('\nLAST-LINE\n'));
    assert.match(r.stdout, /… \d+ bytes omitted …/);
    assert.equal(r.stderr, 'warn');
    assert.deepEqual(chan.signals, [], 'no TERM for output');
    assert.equal(chan.closed, 0, 'channel not closed by the driver');
  });

  await check('driver: exec over its timeout -> RemoteError timeout, channel closed', async () => {
    const { client } = makeSsh2();
    let chan;
    client.execImpl = (_cmd, cb) => { chan = fakeChannel(); cb(undefined, chan); };
    const d = await createSsh2Driver(client, { onLost() {} });
    const err = await rejection(() => d.exec('x', { timeoutMs: 20, maxOutputBytes: 4, terminateOnTimeout: true }));
    assert.equal(err.code, 'timeout');
    assert.ok(chan.closed >= 1);
    assert.deepEqual(chan.signals, [{ name: 'TERM', closedBefore: 0 }], 'TERM sent before the channel closes');
  });

  await check('driver: write stream emits open once the SFTP handle is open; a denied open errors without open', async () => {
    const make = (fail) => () => {
      const w = new EventEmitter();
      w.write = (_c, _e, cb) => cb();
      w.end = () => setImmediate(() => w.emit('close'));
      w.destroy = () => { w.destroyed = true; setImmediate(() => w.emit('close')); };
      setImmediate(() => (fail ? w.emit('error', sftpErr(3, 'Permission denied')) : w.emit('open', Buffer.from('h'))));
      return w;
    };
    for (const fail of [false, true]) {
      const { client } = makeSsh2({ createWriteStream: make(fail) });
      const d = await createSsh2Driver(client, { onLost() {} });
      const out = d.fs.createWriteStream('/t', 0o644);
      let opened = false;
      out.once('open', () => { opened = true; });
      const err = await new Promise((resolve) => { out.once('error', resolve); setTimeout(() => resolve(null), 30); });
      assert.equal(opened, !fail);
      if (fail) assert.equal(err.code, 'denied');
      else assert.equal(err, null);
      out.destroy();
    }
  });

  await check('driver: abort signal -> TERM, channel closed, RemoteError aborted with partial output', async () => {
    const { client } = makeSsh2();
    let chan;
    client.execImpl = (_cmd, cb) => { chan = fakeChannel(); cb(undefined, chan); };
    const d = await createSsh2Driver(client, { onLost() {} });
    const ac = new AbortController();
    const running = rejection(() => d.exec('x', { timeoutMs: 10_000, maxOutputBytes: 100, terminateOnTimeout: true, signal: ac.signal }));
    await sleep(5);
    chan.emit('data', Buffer.from('so far'));
    chan.stderr.emit('data', Buffer.from('warn'));
    ac.abort();
    const err = await running;
    assert.equal(err.code, 'aborted');
    assert.deepEqual(err.partial, { stdout: 'so far', stderr: 'warn' });
    assert.deepEqual(chan.signals, [{ name: 'TERM', closedBefore: 0 }]);
    assert.ok(chan.closed >= 1);
  });

  await check('driver: output over the cap -> TERM once, then channel closed; timeout partial marks truncated', async () => {
    const { client } = makeSsh2();
    let chan;
    client.execImpl = (_cmd, cb) => { chan = fakeChannel(); cb(undefined, chan); };
    const d = await createSsh2Driver(client, { onLost() {} });
    const running = d.exec('yes', { timeoutMs: 10_000, maxOutputBytes: 4, terminateOnTimeout: true });
    await sleep(5);
    chan.emit('data', Buffer.from('abcdef'));
    chan.emit('data', Buffer.from('more'));
    const res = await running;
    assert.equal(res.truncated, true);
    assert.equal(res.code, null);
    assert.equal(res.stdout, 'abcd');
    assert.deepEqual(chan.signals, [{ name: 'TERM', closedBefore: 0 }]);
    // A channel that never closes after the cap: the timeout's partial keeps the flag.
    let chan2;
    client.execImpl = (_cmd, cb) => { chan2 = fakeChannel(); chan2.close = () => { chan2.closed += 1; }; cb(undefined, chan2); };
    const p2 = rejection(() => d.exec('yes', { timeoutMs: 40, maxOutputBytes: 2, terminateOnTimeout: true }));
    await sleep(5);
    chan2.emit('data', Buffer.from('xyz'));
    const err = await p2;
    assert.equal(err.code, 'timeout');
    assert.deepEqual(err.partial, { stdout: 'xy', stderr: '', truncated: true });
  });

  await check('driver: timeout carries partial output; already aborted signal -> no channel opened', async () => {
    const { client } = makeSsh2();
    let chan;
    let opened = 0;
    client.execImpl = (_cmd, cb) => { opened += 1; chan = fakeChannel(); cb(undefined, chan); setImmediate(() => chan.emit('data', Buffer.from('abc'))); };
    const d = await createSsh2Driver(client, { onLost() {} });
    const err = await rejection(() => d.exec('x', { timeoutMs: 30, maxOutputBytes: 100, terminateOnTimeout: true }));
    assert.equal(err.code, 'timeout');
    assert.deepEqual(err.partial, { stdout: 'abc', stderr: '' });
    const ac = new AbortController();
    ac.abort();
    const err2 = await rejection(() => d.exec('y', { timeoutMs: 1000, maxOutputBytes: 100, terminateOnTimeout: true, signal: ac.signal }));
    assert.equal(err2.code, 'aborted');
    assert.equal(opened, 1);
  });

  await check('driver: exec timeout with terminateOnTimeout false -> no signal, channel closed', async () => {
    const { client } = makeSsh2();
    let chan;
    client.execImpl = (_cmd, cb) => { chan = fakeChannel(); cb(undefined, chan); };
    const d = await createSsh2Driver(client, { onLost() {} });
    const err = await rejection(() => d.exec('rm', { timeoutMs: 20, maxOutputBytes: 4, terminateOnTimeout: false }));
    assert.equal(err.code, 'timeout');
    assert.ok(chan.closed >= 1);
    assert.deepEqual(chan.signals, []);
  });

  await check('driver: a server without signal support (throws) still closes the channel', async () => {
    const { client } = makeSsh2();
    let chan;
    client.execImpl = (_cmd, cb) => { chan = fakeChannel(); chan.signal = () => { throw new Error('nope'); }; cb(undefined, chan); };
    const d = await createSsh2Driver(client, { onLost() {} });
    const err = await rejection(() => d.exec('x', { timeoutMs: 20, maxOutputBytes: 4, terminateOnTimeout: true }));
    assert.equal(err.code, 'timeout');
    assert.ok(chan.closed >= 1);
  });

  // ---- drop hooks ------------------------------------------------------------

  await check('listener: ssh.connection.changed -> dropByConnection + invalidate', async () => {
    const calls = [];
    const sessions = { dropByConnection: (id) => calls.push(['drop', id]) };
    const access = { invalidate: (...args) => calls.push(['inv', ...args]) };
    const l = new SshConnectionChangeListener(sessions, access);
    l.onConnectionChanged({ connectionId: 'c9' });
    assert.deepEqual(calls, [['drop', 'c9'], ['inv']]);
    l.onConnectionChanged({});
    assert.deepEqual(calls.slice(2), [['inv']]);
    const meta = Reflect.getMetadata(EVENT_LISTENER_METADATA, SshConnectionChangeListener.prototype.onConnectionChanged);
    assert.ok(JSON.stringify(meta).includes(SSH_CONNECTION_CHANGED), 'decorated with @OnEvent');
  });

  function makeSshService() {
    const events = [];
    const doc = { _id: { toString: () => 'c7' }, label: 'prod', host: 'h', port: 22, __v: 0, save: async () => doc };
    const exec = (v) => ({ exec: async () => v });
    const sshModel = {
      findOneAndUpdate: () => exec({ ...doc, label: 'new' }),
      deleteOne: () => exec({}),
    };
    const secretModel = { deleteMany: () => exec({}) };
    const svc = new SshService(sshModel, secretModel, {}, {}, { emit: (name, payload) => { events.push({ name, payload }); return true; } }, {});
    svc.findById = async () => doc;
    svc.assertSecretRefsAccessible = async () => undefined;
    return { svc, events };
  }
  const changed = (events) => events.filter((e) => e.name === SSH_CONNECTION_CHANGED).map((e) => e.payload.connectionId);

  await check('SshService.update emits ssh.connection.changed', async () => {
    const { svc, events } = makeSshService();
    await svc.update('c7', { label: 'new' });
    assert.deepEqual(changed(events), ['c7']);
  });
  await check('SshService.delete emits ssh.connection.changed', async () => {
    const { svc, events } = makeSshService();
    await svc.delete('c7');
    assert.deepEqual(changed(events), ['c7']);
  });
  await check('SshService.setKnownHostFingerprint emits ssh.connection.changed', async () => {
    const { svc, events } = makeSshService();
    await svc.setKnownHostFingerprint('c7', 'SHA256:x');
    assert.deepEqual(changed(events), ['c7']);
  });
  await check('SshService.recordConnectSuccess does NOT emit ssh.connection.changed', async () => {
    const { svc, events } = makeSshService();
    await svc.recordConnectSuccess('c7');
    await svc.recordConnectError('c7', 'x');
    assert.deepEqual(changed(events), []);
  });

  await check('WorkspacesService.archive/remove drop the workspace session', async () => {
    const mongoose = nm('mongoose');
    const id = new mongoose.Types.ObjectId();
    const ws = { _id: id, projectId: new mongoose.Types.ObjectId(), name: 'w' };
    const exec = (v) => ({ exec: async () => v });
    const model = {
      findById: () => exec(ws),
      findByIdAndUpdate: () => exec(ws),
      findByIdAndDelete: () => exec(ws),
    };
    const dropped = [];
    const svc = new WorkspacesService(model, { emit() {} }, {}, { drop: (x) => dropped.push(String(x)) });
    await svc.archive(String(id));
    await svc.remove(String(id));
    assert.deepEqual(dropped, [String(id), String(id)]);
  });

  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
})();
