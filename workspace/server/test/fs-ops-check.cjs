#!/usr/bin/env node
/*
 * Sidecar fs-ops check: /read hash + strictText, /tree withSize,
 * /write with optimistic conflict detection, /write-stream regression.
 *
 * Spawns `node index.js` as a child process (the server starts at import
 * time and exports nothing) against a temporary workspace root.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TOKEN = 'test-token-0123456789';
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

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

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-ops-check-'));
  const root = path.join(tmp, 'root');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(root, 'ws1'), { recursive: true });
  fs.mkdirSync(outside);
  const ws = path.join(root, 'ws1');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: { ...process.env, WORKSPACE_ROOT: root, WORKSPACE_API_TOKEN: TOKEN, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const cleanup = () => {
    child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i += 1) {
      try { up = (await fetch(`${base}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    if (!up) throw new Error('sidecar did not come up');

    const post = async (route, body) => {
      const res = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const readDisk = (rel) => fs.readFileSync(path.join(ws, rel), 'utf8');
    const entry = (p, tree) => tree.body.entries.find((e) => e.path === p);
    const put = (rel, data) => fs.writeFileSync(path.join(ws, rel), data);

    put('a.txt', 'hello\n');
    put('bin.dat', Buffer.from([0x61, 0x00, 0x62]));
    put('latin1.txt', Buffer.from([0x63, 0xe4, 0x64]));

    await check('read: hash is sha256 of raw bytes', async () => {
      const r = await post('/read', { workspaceId: 'ws1', path: 'a.txt' });
      assert.equal(r.status, 200);
      assert.equal(r.body.hash, sha256('hello\n'));
      assert.equal(r.body.content, 'hello\n');
    });

    await check('read: strictText rejects binary and invalid utf-8, default stays lenient', async () => {
      const bin = await post('/read', { workspaceId: 'ws1', path: 'bin.dat', strictText: true });
      assert.equal(bin.status, 415);
      assert.equal(bin.body.error, 'not utf-8 text');
      assert.equal(bin.body.size, 3);
      assert.equal((await post('/read', { workspaceId: 'ws1', path: 'latin1.txt', strictText: true })).status, 415);
      assert.equal((await post('/read', { workspaceId: 'ws1', path: 'latin1.txt' })).status, 200);
      assert.equal((await post('/read', { workspaceId: 'ws1', path: 'a.txt', strictText: true })).status, 200);
    });

    await check('tree: withSize adds size to files only when requested', async () => {
      const sized = await post('/tree', { workspaceId: 'ws1', path: '.', depth: 1, withSize: true });
      assert.equal(entry('a.txt', sized).size, 6);
      const plain = await post('/tree', { workspaceId: 'ws1', path: '.', depth: 1 });
      assert.equal(entry('a.txt', plain).size, undefined);
    });

    await check('write: matching baseHash succeeds and returns new hash', async () => {
      const w = await post('/write', { workspaceId: 'ws1', path: 'a.txt', content: 'x', baseHash: sha256('hello\n') });
      assert.equal(w.status, 200);
      assert.equal(w.body.ok, true);
      assert.equal(w.body.hash, sha256('x'));
      assert.equal(w.body.size, 1);
      assert.equal(readDisk('a.txt'), 'x');
    });

    await check('write: stale baseHash -> 409 with currentHash, file untouched', async () => {
      const w = await post('/write', { workspaceId: 'ws1', path: 'a.txt', content: 'y', baseHash: sha256('hello\n') });
      assert.equal(w.status, 409);
      assert.equal(w.body.error, 'conflict');
      assert.equal(w.body.currentHash, sha256('x'));
      assert.equal(readDisk('a.txt'), 'x');
    });

    await check('write: force overrides a stale baseHash', async () => {
      const w = await post('/write', { workspaceId: 'ws1', path: 'a.txt', content: 'forced', baseHash: 'stale', force: true });
      assert.equal(w.status, 200);
      assert.equal(readDisk('a.txt'), 'forced');
    });

    await check('write: baseHash null conflicts on existing file, creates a missing one', async () => {
      const w = await post('/write', { workspaceId: 'ws1', path: 'a.txt', content: 'z', baseHash: null });
      assert.equal(w.status, 409);
      assert.equal(w.body.currentHash, sha256('forced'));
      const c = await post('/write', { workspaceId: 'ws1', path: 'fresh.txt', content: 'new', baseHash: null });
      assert.equal(c.status, 200);
      assert.equal(readDisk('fresh.txt'), 'new');
    });

    await check('write: string baseHash on a missing file -> 409 with currentHash null', async () => {
      const w = await post('/write', { workspaceId: 'ws1', path: 'ghost.txt', content: 'q', baseHash: sha256('q') });
      assert.equal(w.status, 409);
      assert.equal(w.body.currentHash, null);
      assert.equal(fs.existsSync(path.join(ws, 'ghost.txt')), false);
    });

    await check('write: keeps mode 0o755 of an existing executable, new files get 0o644', async () => {
      put('run.sh', '#!/bin/sh\n');
      fs.chmodSync(path.join(ws, 'run.sh'), 0o755);
      const w = await post('/write', { workspaceId: 'ws1', path: 'run.sh', content: '#!/bin/sh\necho hi\n', baseHash: sha256('#!/bin/sh\n') });
      assert.equal(w.status, 200);
      assert.equal(fs.statSync(path.join(ws, 'run.sh')).mode & 0o777, 0o755);
      assert.equal(fs.statSync(path.join(ws, 'fresh.txt')).mode & 0o777, 0o644);
    });

    await check('write: CRLF and missing trailing newline are stored byte-identical', async () => {
      const content = 'one\r\ntwo\r\nthree';
      const w = await post('/write', { workspaceId: 'ws1', path: 'crlf.txt', content, baseHash: null });
      assert.equal(w.status, 200);
      assert.deepEqual(fs.readFileSync(path.join(ws, 'crlf.txt')), Buffer.from(content));
      assert.equal(w.body.hash, sha256(content));
    });

    await check('write: special file names round-trip through /write and /read', async () => {
      for (const p of ['dir with space/ümlaut #1?.txt', '-leading-dash.txt']) {
        const content = `content of ${p}\n`;
        const w = await post('/write', { workspaceId: 'ws1', path: p, content, baseHash: null, createDirs: true });
        assert.equal(w.status, 200, p);
        const r = await post('/read', { workspaceId: 'ws1', path: p });
        assert.equal(r.body.content, content);
        assert.equal(r.body.hash, w.body.hash);
      }
    });

    await check('write: missing parent without createDirs -> 404, no leftover temp files', async () => {
      const w = await post('/write', { workspaceId: 'ws1', path: 'nope/x.txt', content: 'a', baseHash: null });
      assert.equal(w.status, 404);
      assert.equal(fs.existsSync(path.join(ws, 'nope')), false);
      assert.deepEqual(fs.readdirSync(ws).filter((n) => n.endsWith('.part')), []);
    });

    await check('write: rejects directory target, escape, NUL in path, non-string content', async () => {
      fs.mkdirSync(path.join(ws, 'adir'));
      assert.equal((await post('/write', { workspaceId: 'ws1', path: 'adir', content: 'a', baseHash: null, force: true })).status, 400);
      assert.equal((await post('/write', { workspaceId: 'ws1', path: '../escape.txt', content: 'a', baseHash: null })).status, 400);
      assert.equal((await post('/write', { workspaceId: 'ws1', path: 'a\0b.txt', content: 'a', baseHash: null })).status, 400);
      assert.equal((await post('/write', { workspaceId: 'ws1', path: 'n.txt', content: 5, baseHash: null })).status, 400);
      assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
    });

    await check('write: path through symlink out of the workspace is rejected, nothing created outside', async () => {
      fs.symlinkSync(outside, path.join(ws, 'out'));
      const a = await post('/write', { workspaceId: 'ws1', path: 'out/x.txt', content: 'a', baseHash: null });
      assert.equal(a.status, 400);
      const b = await post('/write', { workspaceId: 'ws1', path: 'out/new/x.txt', content: 'a', baseHash: null, createDirs: true });
      assert.equal(b.status, 400);
      assert.deepEqual(fs.readdirSync(outside), []);
    });

    await check('write: 6 MB content -> 413', async () => {
      const w = await post('/write', { workspaceId: 'ws1', path: 'big.txt', content: 'a'.repeat(6 * 1024 * 1024), baseHash: null });
      assert.equal(w.status, 413);
      assert.equal(fs.existsSync(path.join(ws, 'big.txt')), false);
    });

    await check('write: requires the bearer token', async () => {
      const res = await fetch(`${base}/write`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 401);
    });

    await check('write-stream: upload and overwrite still work', async () => {
      const up = async (data) => {
        const q = new URLSearchParams({ workspaceId: 'ws1', path: 'up.bin', size: String(data.length) });
        const res = await fetch(`${base}/write-stream?${q}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream' },
          body: data,
        });
        return { status: res.status, body: await res.json() };
      };
      const first = await up(Buffer.from('first'));
      assert.equal(first.status, 200);
      assert.equal(first.body.size, 5);
      const second = await up(Buffer.from('second!'));
      assert.equal(second.status, 200);
      assert.equal(readDisk('up.bin'), 'second!');
    });
  } finally {
    cleanup();
  }

  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
