#!/usr/bin/env node
/*
 * Sidecar- und Socket-Verfügbarkeit (Review §8 Punkt 25: H-5, M-21…M-26,
 * M-44, M-52, M-53).
 *
 * Startet den ECHTEN Workspace-Sidecar (workspace/server/index.js) als
 * Kindprozess auf einem freien Port mit einem Temp-Verzeichnis als ROOT und
 * prüft gegen ihn:
 *   - M-21 die Exploit-Kette: präpariertes core.fsmonitor + /status. Der
 *     Hook schreibt seine Umgebung in eine Datei — WORKSPACE_API_TOKEN darf
 *     darin nicht stehen.
 *   - H-5  ein werfendes await in einer Route ergibt 500, der Prozess lebt.
 *   - M-23 ungültige und doppelte sessionIds werden beim Upgrade abgewiesen.
 *   - M-24 ein unsinniger Zahlenwert in der Umgebung bricht den Start ab.
 *   - M-25 SIGTERM beendet den Prozess sauber.
 * Dazu Backend-Teile: M-52 (Download-Wächter) und M-44 (SFTP-Watchdog gibt
 * den Slot frei, auch wenn der SFTP-Callback nie kommt).
 *
 * Braucht git und dist/ (`npm run build`). Für den Sidecar-Teil
 * `npm ci` in workspace/server (node-pty).
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const assert = require('node:assert/strict');

process.env.SSH_SFTP_TIMEOUT_MS = '300';

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}
const { guardStream } = loadCompiled('common/stream-guard.js');
const { SshSessionService } = loadCompiled('ssh/ssh-session.service.js');
const WebSocket = require(path.resolve(__dirname, '..', 'node_modules', 'ws'));

const SIDECAR = path.resolve(__dirname, '..', '..', 'workspace', 'server', 'index.js');
const TOKEN = 'socket-safety-check-token-0123456789';

const EXPECTED_CHECKS = 8;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startSidecar(extraEnv = {}) {
  const port = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-sidecar-'));
  const child = spawn(process.execPath, [SIDECAR], {
    cwd: path.dirname(SIDECAR),
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), WORKSPACE_API_TOKEN: TOKEN, WORKSPACE_ROOT: root, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  for (let i = 0; i < 100; i++) {
    if (log.includes('listening on')) break;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body) => fetch(base + p, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { child, root, port, base, post, exited, log: () => log };
}

function wsStatus(port, query) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term?${query}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    ws.on('open', () => resolve({ open: true, ws }));
    ws.on('unexpected-response', (_req, res) => resolve({ open: false, status: res.statusCode }));
    ws.on('error', () => resolve({ open: false, status: 0 }));
  });
}

(async () => {
  const sc = await startSidecar();
  try {
    await check('M-21: git-Hook aus /status sieht WORKSPACE_API_TOKEN nicht', async () => {
      const id = 'a'.repeat(24);
      const ws = path.join(sc.root, id);
      fs.mkdirSync(ws, { recursive: true });
      execFileSync('git', ['init', '-q', ws]);
      const dump = path.join(sc.root, 'env-dump.txt');
      const hook = path.join(sc.root, 'fsmonitor.sh');
      fs.writeFileSync(hook, `#!/bin/sh\nenv > ${dump}\nexit 1\n`, { mode: 0o755 });
      execFileSync('git', ['-C', ws, 'config', 'core.fsmonitor', hook]);
      const res = await sc.post('/status', { workspaceId: id });
      assert.ok(res.status === 200 || res.status === 500, `status ${res.status}`);
      assert.ok(fs.existsSync(dump), 'Hook lief nicht — Testaufbau prüfen');
      const env = fs.readFileSync(dump, 'utf8');
      assert.ok(!env.includes(TOKEN), 'Sidecar-Token in der Umgebung eines git-Hooks');
      assert.ok(!/WORKSPACE_API_TOKEN/.test(env));
    });

    await check('H-5: werfendes await in einer Route -> 500, Prozess lebt weiter', async () => {
      // Eine Datei an der Stelle des Workspace-Verzeichnisses lässt mkdir werfen.
      const id = 'b'.repeat(24);
      fs.writeFileSync(path.join(sc.root, id), 'kein Verzeichnis');
      const res = await sc.post('/exec', { workspaceId: id, command: 'true' });
      assert.equal(res.status, 500);
      const health = await fetch(`${sc.base}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(health.status, 200, 'Sidecar ist nach dem Fehler gestorben');
    });

    await check('M-23: ungültige sessionId -> 400, doppelte -> 409', async () => {
      const id = 'c'.repeat(24);
      const bad = await wsStatus(sc.port, `workspaceId=${id}&sessionId=a:b`);
      assert.equal(bad.status, 400);
      const first = await wsStatus(sc.port, `workspaceId=${id}&sessionId=s1`);
      assert.ok(first.open, `erstes Terminal nicht geöffnet (${first.status})`);
      const dup = await wsStatus(sc.port, `workspaceId=${id}&sessionId=s1`);
      assert.equal(dup.status, 409);
      first.ws.close();
    });

    await check('M-25: SIGTERM beendet den Sidecar sauber', async () => {
      sc.child.kill('SIGTERM');
      const { code } = await Promise.race([sc.exited, new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 8000))]);
      assert.equal(code, 0);
    });
  } finally {
    if (sc.child.exitCode === null) sc.child.kill('SIGKILL');
  }

  await check('M-24: unsinniger Zahlenwert in der Umgebung bricht den Start ab', async () => {
    const bad = await startSidecar({ READ_MAX_BYTES: 'MB50' });
    const { code } = await Promise.race([bad.exited, new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 5000))]);
    if (bad.child.exitCode === null) bad.child.kill('SIGKILL');
    assert.equal(code, 1);
    assert.match(bad.log(), /READ_MAX_BYTES/);
  });

  await check('M-52: Download-Wächter bricht bei Funkstille ab', async () => {
    let aborted = null;
    const silent = new Readable({ read() {} });
    const guarded = guardStream(silent, { idleMs: 100, maxBytes: 1e9, onAbort: (e) => { aborted = e; } });
    const err = await new Promise((r) => { guarded.on('error', r); guarded.resume(); });
    assert.match(String(err.message), /ohne Daten/);
    assert.ok(aborted);
  });

  await check('M-52: Download-Wächter bricht bei Überschreiten der Grenze ab', async () => {
    const big = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]);
    const guarded = guardStream(big, { idleMs: 10_000, maxBytes: 1000, onAbort: () => {} });
    const err = await new Promise((r) => { guarded.on('error', r); guarded.resume(); });
    assert.match(String(err.message), /überschreitet/);
  });

  await check('M-44: hängendes SFTP gibt Slot und Client trotzdem frei', async () => {
    const svc = new SshSessionService(
      { findById: async () => ({ _id: 'c1' }) }, {}, { create: async () => ({}) }, {}, { get: async () => null },
    );
    let destroyed = false;
    svc.resolveCredentialsOrFail = async () => ({});
    svc.openClient = async () => ({ end() {}, destroy() { destroyed = true; } });
    svc.openSftp = () => new Promise(() => {}); // hängt für immer
    await assert.rejects(() => svc.sftpDownload('c1', '/etc/x'), /timeout/);
    assert.equal(svc.concurrency.get('c1'), undefined, 'Slot blieb belegt');
    assert.ok(destroyed, 'Client wurde nicht zerstört');
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
