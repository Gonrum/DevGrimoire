#!/usr/bin/env node
/*
 * SSH terminal bridge (SSH-Werkstatt, Task 8).
 *
 * - cwdShellCommand: exact output, and a round trip through a real local `sh`
 *   for a directory with `'` and a space (a fake $SHELL prints its cwd).
 * - bridgeSshTerminal with a fake ssh2 client and a fake WebSocket (no
 *   network): exec vs shell start, PTY size from an early resize frame,
 *   resize -> setWindow, stdin (also typed before the channel exists),
 *   stdout/stderr -> binary frames, exit -> JSON frame, WS close -> client.end
 *   + terminal_close audit, connect error -> mapped close code, idle close
 *   with the dedicated code, input and output resetting the idle timer.
 * - sshConnectErrorToCloseCode keeps its mapping.
 *
 * Loads from dist/; run `npm run build` first.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { execFileSync, spawnSync } = require('node:child_process');

const abs = path.resolve(__dirname, '..', 'dist', 'ssh/ssh-terminal-bridge.js');
let mod;
try { mod = require(abs); } catch (err) {
  console.error(`Failed to load ${abs}. Run \`npm run build\` first.\n${err.message}`);
  process.exit(2);
}
const { bridgeSshTerminal, cwdShellCommand, sshConnectErrorToCloseCode, TERMINAL_IDLE_CLOSE_CODE } = mod;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`ok   ${label}`); }
  catch (err) { failures += 1; console.error(`FAIL ${label}\n     ${err && err.stack ? err.stack : err}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; this.closedWith = null; }
  send(data, opts) { this.sent.push({ data, binary: Boolean(opts && opts.binary) }); }
  close(code, reason) {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
    setImmediate(() => this.emit('close', code, Buffer.from(reason || '')));
  }
  /** Simulates a frame from the browser. */
  input(text, isBinary = false) { this.emit('message', isBinary ? Buffer.from(text) : Buffer.from(text), isBinary); }
  textFrames() { return this.sent.filter((s) => !s.binary).map((s) => String(s.data)); }
}

class FakeChannel extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); this.writes = []; this.windows = []; this.closed = false; }
  write(d) { this.writes.push(Buffer.isBuffer(d) ? d.toString('utf8') : String(d)); return true; }
  setWindow(rows, cols, h, w) { this.windows.push([rows, cols, h, w]); }
  close() { this.closed = true; }
}

class FakeClient extends EventEmitter {
  constructor() { super(); this.calls = []; this.ended = 0; this.destroyed = 0; this.channel = null; }
  shell(opts, cb) {
    this.calls.push({ kind: 'shell', opts });
    this.channel = new FakeChannel();
    setImmediate(() => cb(undefined, this.channel));
  }
  exec(cmd, opts, cb) {
    this.calls.push({ kind: 'exec', cmd, opts });
    this.channel = new FakeChannel();
    setImmediate(() => cb(undefined, this.channel));
  }
  end() { this.ended += 1; }
  destroy() { this.destroyed += 1; }
}

function setup({ start = { kind: 'shell' }, idleMs = 60_000, connect, initial = { cols: 80, rows: 24 } } = {}) {
  const ws = new FakeWs();
  const client = new FakeClient();
  const audits = [];
  const p = bridgeSshTerminal({
    clientWs: ws,
    connect: connect || (async () => client),
    start,
    initial,
    idleMs,
    audit: (action, durationMs) => audits.push({ action, durationMs }),
  });
  return { ws, client, audits, p };
}

(async () => {
  await check('cwdShellCommand: exact string', () => {
    assert.equal(cwdShellCommand("/srv/it's"), `cd -- '/srv/it'\\''s' && exec "\${SHELL:-/bin/sh}" -l`);
  });

  await check('cwdShellCommand: real sh lands in a directory with quote and space', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-term-bridge-'));
    try {
      const dir = path.join(tmp, "it's a dir");
      fs.mkdirSync(dir);
      const fakeShell = path.join(tmp, 'fake-shell');
      fs.writeFileSync(fakeShell, '#!/bin/sh\nprintf "%s|%s" "$(pwd -P)" "$1"\n');
      fs.chmodSync(fakeShell, 0o755);
      const out = execFileSync('sh', ['-c', cwdShellCommand(dir)], {
        encoding: 'utf8', env: { ...process.env, SHELL: fakeShell }, cwd: '/',
      });
      assert.equal(out, `${fs.realpathSync(dir)}|-l`);
      // A missing directory: cd fails, the shell is not started, sh reports it.
      const res = spawnSync('sh', ['-c', cwdShellCommand(path.join(tmp, 'missing'))], {
        encoding: 'utf8', env: { ...process.env, SHELL: fakeShell },
      });
      assert.notEqual(res.status, 0);
      assert.equal(res.stdout, '');
      assert.match(res.stderr, /missing/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  await check('sshConnectErrorToCloseCode: mapping unchanged', () => {
    assert.equal(sshConnectErrorToCloseCode('host_key_mismatch'), 4001);
    assert.equal(sshConnectErrorToCloseCode('tofu_not_accepted'), 4002);
    assert.equal(sshConnectErrorToCloseCode('credential_missing: gone'), 4003);
    assert.equal(sshConnectErrorToCloseCode('auth_failed'), 4004);
    for (const c of ['timeout', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET']) {
      assert.equal(sshConnectErrorToCloseCode(c), 4008, c);
    }
    assert.equal(sshConnectErrorToCloseCode('weird'), 1011);
    assert.equal(TERMINAL_IDLE_CLOSE_CODE, 4010);
  });

  await check('cwd start: exec with pty, size from a resize sent before connect', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const client = new FakeClient();
    const { ws, audits, p } = setup({
      start: { kind: 'cwd', path: "/srv/it's" },
      connect: async () => { await gate; return client; },
    });
    ws.input(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    ws.input('ls\n'); // typed before the channel exists
    release();
    await p;
    await tick(); await tick();
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].kind, 'exec');
    assert.equal(client.calls[0].cmd, cwdShellCommand("/srv/it's"));
    assert.deepEqual(client.calls[0].opts, { pty: { term: 'xterm-256color', cols: 120, rows: 40 } });
    assert.deepEqual(client.channel.writes, ['ls\n'], 'early stdin is delivered once the channel is open');
    assert.deepEqual(audits.map((a) => a.action), ['terminal_open']);
    ws.close(1000, '');
    await tick(); await tick();
  });

  await check('shell start: shell(), resize -> setWindow, stdin, output, exit, close', async () => {
    const { ws, client, audits, p } = setup();
    await p;
    await tick(); await tick();
    assert.equal(client.calls[0].kind, 'shell');
    assert.deepEqual(client.calls[0].opts, { term: 'xterm-256color', cols: 80, rows: 24 });
    const ch = client.channel;
    ws.input(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    assert.deepEqual(ch.windows[ch.windows.length - 1], [30, 100, 0, 0]);
    ws.input(JSON.stringify({ type: 'resize', cols: 0, rows: 30 })); // invalid: ignored
    assert.deepEqual(ch.windows[ch.windows.length - 1], [30, 100, 0, 0]);
    ws.input('echo hi\n');
    ws.input('bin', true);
    assert.deepEqual(ch.writes, ['echo hi\n', 'bin']);
    ch.emit('data', Buffer.from('out'));
    ch.stderr.emit('data', Buffer.from('err'));
    const bins = ws.sent.filter((s) => s.binary).map((s) => String(s.data));
    assert.deepEqual(bins, ['out', 'err']);
    ch.emit('exit', 3);
    assert.deepEqual(JSON.parse(ws.textFrames().pop()), { type: 'exit', exitCode: 3 });
    ws.close(1000, '');
    await tick(); await tick();
    assert.ok(client.ended >= 1, 'client.end() on WS close');
    assert.equal(ch.closed, true);
    assert.deepEqual(audits.map((a) => a.action), ['terminal_open', 'terminal_close']);
    assert.equal(typeof audits[1].durationMs, 'number');
  });

  await check('connect error host_key_mismatch -> 4001, no audit, no channel', async () => {
    const { ws, audits, p } = setup({ connect: async () => { throw new Error('host_key_mismatch'); } });
    await p;
    await tick();
    assert.equal(ws.closedWith.code, 4001);
    assert.equal(ws.closedWith.reason, 'host_key_mismatch');
    await tick();
    assert.deepEqual(audits, []);
  });

  await check('WS closed during connect: fresh client is released, no audit', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const client = new FakeClient();
    const { ws, audits, p } = setup({ connect: async () => { await gate; return client; } });
    ws.close(1000, '');
    await tick();
    release();
    await p;
    await tick();
    assert.ok(client.ended >= 1);
    assert.equal(client.calls.length, 0);
    assert.deepEqual(audits, []);
  });

  await check('idle: closed with the dedicated code after the limit', async () => {
    const { ws, client, audits, p } = setup({ idleMs: 80 });
    await p;
    await sleep(250);
    assert.ok(ws.closedWith, 'closed');
    assert.equal(ws.closedWith.code, TERMINAL_IDLE_CLOSE_CODE);
    assert.equal(ws.closedWith.reason, 'idle_timeout');
    assert.ok(client.ended >= 1);
    await tick();
    assert.deepEqual(audits.map((a) => a.action), ['terminal_open', 'terminal_close']);
  });

  await check('idle: input resets the timer', async () => {
    const { ws, p } = setup({ idleMs: 150 });
    await p;
    for (let i = 0; i < 8; i += 1) { await sleep(50); ws.input('x'); }
    assert.equal(ws.closedWith, null, 'still open while typing');
    await sleep(300);
    assert.equal(ws.closedWith && ws.closedWith.code, TERMINAL_IDLE_CLOSE_CODE);
  });

  await check('idle: output resets the timer', async () => {
    const { ws, client, p } = setup({ idleMs: 150 });
    await p;
    await tick(); await tick();
    for (let i = 0; i < 8; i += 1) { await sleep(50); client.channel.emit('data', Buffer.from('.')); }
    assert.equal(ws.closedWith, null, 'still open while output flows');
    await sleep(300);
    assert.equal(ws.closedWith && ws.closedWith.code, TERMINAL_IDLE_CLOSE_CODE);
  });

  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
})();
