#!/usr/bin/env node
/*
 * Sidecar terminal idle limit: a terminal without input or output is closed
 * with close code 4010 / reason `idle_timeout`. The backend passes the limit
 * per terminal in `X-Dg-Idle-Ms`; values outside 5 min - 24 h (or missing)
 * fall back to TERMINAL_IDLE_MS. Input keeps a terminal alive.
 *
 * Spawns `node index.js` with a short TERMINAL_IDLE_MS / TERMINAL_SWEEP_MS
 * against a temporary workspace root.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const TOKEN = 'test-token-0123456789';
const IDLE_MS = 600;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Opens a terminal; resolves with the socket and a promise of its close event. */
function openTerm(port, sessionId, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term?workspaceId=ws1&sessionId=${sessionId}`, {
      headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    });
    const closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    ws.on('open', () => resolve({ ws, closed }));
    ws.on('error', reject);
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-idle-check-'));
  const root = path.join(tmp, 'root');
  fs.mkdirSync(path.join(root, 'ws1'), { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: {
      ...process.env, WORKSPACE_ROOT: root, WORKSPACE_API_TOKEN: TOKEN, PORT: String(port),
      TERMINAL_IDLE_MS: String(IDLE_MS), TERMINAL_SWEEP_MS: '100',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const cleanup = () => {
    child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i += 1) {
      try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { await sleep(100); }
    }
    if (!up) throw new Error('sidecar did not come up');

    const raceClose = (closed, ms) => Promise.race([closed, sleep(ms).then(() => null)]);

    await check('no header: closed after TERMINAL_IDLE_MS with 4010 idle_timeout', async () => {
      const { closed } = await openTerm(port, 'idle-a');
      const res = await raceClose(closed, IDLE_MS + 2000);
      assert.ok(res, 'terminal was not closed');
      assert.equal(res.code, 4010);
      assert.equal(res.reason, 'idle_timeout');
    });

    await check('header below 5 min or above 24 h: falls back to TERMINAL_IDLE_MS', async () => {
      for (const [id, v] of [['idle-b', '1000'], ['idle-c', String(24 * 3600_000 + 1)], ['idle-d', 'abc']]) {
        const { closed } = await openTerm(port, id, { 'x-dg-idle-ms': v });
        const res = await raceClose(closed, IDLE_MS + 2000);
        assert.ok(res, `terminal with header ${v} was not closed`);
        assert.equal(res.code, 4010);
      }
    });

    await check('valid header (5 min) is used instead of the fallback', async () => {
      const { ws, closed } = await openTerm(port, 'idle-e', { 'x-dg-idle-ms': String(5 * 60_000) });
      const res = await raceClose(closed, IDLE_MS * 3);
      assert.equal(res, null, 'closed although the per-terminal limit is 5 min');
      ws.close();
    });

    await check('input keeps the terminal open', async () => {
      const { ws, closed } = await openTerm(port, 'idle-f');
      let res = null;
      for (let i = 0; i < 12 && !res; i += 1) {
        ws.send(':\n');
        res = await raceClose(closed, 150);
      }
      assert.equal(res, null, 'closed although input kept arriving');
      res = await raceClose(closed, IDLE_MS + 2000);
      assert.ok(res && res.code === 4010, 'closed after input stopped');
    });
  } finally {
    cleanup();
  }

  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
