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

    const exists = (rel) => fs.existsSync(path.join(ws, rel));
    const upStream = async (rel, data, extra = {}) => {
      const q = new URLSearchParams({ workspaceId: 'ws1', path: rel, size: String(data.length), ...extra });
      const res = await fetch(`${base}/write-stream?${q}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream' },
        body: data,
      });
      return { status: res.status, body: await res.json() };
    };

    await check('mkdir: creates nested dirs, second call -> 409', async () => {
      const a = await post('/mkdir', { workspaceId: 'ws1', path: 'm/n/o' });
      assert.equal(a.status, 200);
      assert.equal(a.body.ok, true);
      assert.equal(a.body.path, 'm/n/o');
      assert.equal(fs.statSync(path.join(ws, 'm/n/o')).isDirectory(), true);
      assert.equal((await post('/mkdir', { workspaceId: 'ws1', path: 'm/n/o' })).status, 409);
      assert.equal((await post('/mkdir', { workspaceId: 'ws1', path: '../x' })).status, 400);
      assert.equal((await post('/mkdir', { workspaceId: 'ws1', path: 'out/viaLink' })).status, 400);
      assert.deepEqual(fs.readdirSync(outside), []);
    });

    await check('move: renames a file and moves a dir', async () => {
      put('mv1.txt', 'one');
      const a = await post('/move', { workspaceId: 'ws1', from: 'mv1.txt', to: 'mv2.txt' });
      assert.equal(a.status, 200);
      assert.deepEqual([a.body.ok, a.body.from, a.body.to], [true, 'mv1.txt', 'mv2.txt']);
      assert.equal(exists('mv1.txt'), false);
      assert.equal(readDisk('mv2.txt'), 'one');
      fs.mkdirSync(path.join(ws, 'srcdir'));
      fs.writeFileSync(path.join(ws, 'srcdir/f.txt'), 'in dir');
      const b = await post('/move', { workspaceId: 'ws1', from: 'srcdir', to: 'm/dstdir' });
      assert.equal(b.status, 200);
      assert.equal(readDisk('m/dstdir/f.txt'), 'in dir');
      assert.equal(exists('srcdir'), false);
    });

    await check('move: target exists -> 409, both files untouched; missing source -> 404', async () => {
      put('t1.txt', 'T1');
      put('t2.txt', 'T2');
      const r = await post('/move', { workspaceId: 'ws1', from: 't1.txt', to: 't2.txt' });
      assert.equal(r.status, 409);
      assert.equal(readDisk('t1.txt'), 'T1');
      assert.equal(readDisk('t2.txt'), 'T2');
      assert.equal((await post('/move', { workspaceId: 'ws1', from: 'nothing-here', to: 'x1' })).status, 404);
    });

    await check('move: root, .git and move-into-self -> 400', async () => {
      fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
      fs.writeFileSync(path.join(ws, '.git/config'), 'cfg');
      fs.mkdirSync(path.join(ws, 'a'));
      put('plain.txt', 'p');
      for (const [from, to] of [['.', 'zz'], ['plain.txt', '.git/x'], ['.git/config', 'cfg2'], ['a', 'a/b'], ['plain.txt', '.']]) {
        const r = await post('/move', { workspaceId: 'ws1', from, to });
        assert.equal(r.status, 400, `${from} -> ${to}`);
      }
      assert.equal(readDisk('.git/config'), 'cfg');
      assert.equal(exists('a/b'), false);
      assert.equal(exists('plain.txt'), true);
    });

    await check('move: special file names (space, umlaut, leading dash) work', async () => {
      put('file with space.txt', 'sp');
      const r = await post('/move', { workspaceId: 'ws1', from: 'file with space.txt', to: 'ünï/-dash.txt' });
      assert.equal(r.status, 200);
      assert.equal(readDisk('ünï/-dash.txt'), 'sp');
      assert.equal(exists('file with space.txt'), false);
    });

    await check('delete: removes file and non-empty dir; root and .git -> 400; missing -> 404', async () => {
      put('del.txt', 'd');
      fs.mkdirSync(path.join(ws, 'deldir/sub'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'deldir/sub/f'), 'x');
      const a = await post('/delete', { workspaceId: 'ws1', path: 'del.txt' });
      assert.equal(a.status, 200);
      assert.deepEqual([a.body.ok, a.body.path], [true, 'del.txt']);
      assert.equal(exists('del.txt'), false);
      assert.equal((await post('/delete', { workspaceId: 'ws1', path: 'deldir' })).status, 200);
      assert.equal(exists('deldir'), false);
      assert.equal((await post('/delete', { workspaceId: 'ws1', path: '.' })).status, 400);
      assert.equal((await post('/delete', { workspaceId: 'ws1', path: '.git' })).status, 400);
      assert.equal((await post('/delete', { workspaceId: 'ws1', path: '.git/config' })).status, 400);
      assert.equal((await post('/delete', { workspaceId: 'ws1', path: '../x' })).status, 400);
      assert.equal(exists('.git/config'), true);
      assert.equal((await post('/delete', { workspaceId: 'ws1', path: 'no-such-thing' })).status, 404);
    });

    await check('delete: a symlink is removed as a link, its outside target survives', async () => {
      const victim = path.join(outside, 'victim.txt');
      fs.writeFileSync(victim, 'keep');
      fs.symlinkSync(victim, path.join(ws, 'link'));
      const r = await post('/delete', { workspaceId: 'ws1', path: 'link' });
      assert.equal(r.status, 200);
      assert.equal(fs.existsSync(victim), true);
      assert.throws(() => fs.lstatSync(path.join(ws, 'link')));
      // Parent resolving outside the workspace must never delete anything.
      const via = await post('/delete', { workspaceId: 'ws1', path: 'out/victim.txt' });
      assert.equal(via.status, 400);
      assert.equal(fs.existsSync(victim), true);
      fs.writeFileSync(path.join(ws, 'mine.txt'), 'm');
      const mv = await post('/move', { workspaceId: 'ws1', from: 'out/victim.txt', to: 'stolen.txt' });
      assert.equal(mv.status, 400);
      assert.equal(fs.existsSync(victim), true);
      const mv2 = await post('/move', { workspaceId: 'ws1', from: 'mine.txt', to: 'out/placed.txt' });
      assert.equal(mv2.status, 400);
      assert.equal(fs.existsSync(path.join(outside, 'placed.txt')), false);
    });

    await check('write-stream: noOverwrite=1 on existing target -> 409, content unchanged, no .part left', async () => {
      put('keep.bin', 'original');
      const r = await upStream('keep.bin', Buffer.from('replacement'), { noOverwrite: '1' });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'target exists');
      assert.equal(readDisk('keep.bin'), 'original');
      assert.deepEqual(fs.readdirSync(ws).filter((n) => n.endsWith('.part')), []);
      const fresh = await upStream('fresh.bin', Buffer.from('new'), { noOverwrite: '1' });
      assert.equal(fresh.status, 200);
      assert.equal(readDisk('fresh.bin'), 'new');
      assert.deepEqual(fs.readdirSync(ws).filter((n) => n.endsWith('.part')), []);
    });

    await check('write-stream: noOverwrite=1 with an 8 MB body on an existing target -> 409 (no connection reset)', async () => {
      put('big-keep.bin', 'original');
      const big = Buffer.alloc(8 * 1024 * 1024, 0x61);
      const r = await upStream('big-keep.bin', big, { noOverwrite: '1' });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'target exists');
      assert.equal(readDisk('big-keep.bin'), 'original');
    });

    await check('write-stream: concurrent noOverwrite uploads -> exactly one wins', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => upStream('race.bin', Buffer.from(`writer-${i}`), { noOverwrite: '1' })),
      );
      assert.equal(results.filter((r) => r.status === 200).length, 1);
      assert.equal(results.filter((r) => r.status === 409).length, 5);
      assert.match(readDisk('race.bin'), /^writer-\d$/);
      assert.deepEqual(fs.readdirSync(ws).filter((n) => n.endsWith('.part')), []);
    });

    put('s1.txt', 'x a.b( y\nHello there\nhello again\naXb(\n');
    const rgLines = (r) => r.body.matches.split('\n').filter(Boolean);

    await check('search: fixedStrings matches literally instead of failing as a regex', async () => {
      const plain = await post('/search', { workspaceId: 'ws1', query: 'a.b(', include: 's1.txt' });
      assert.equal(plain.status, 500);
      const r = await post('/search', { workspaceId: 'ws1', query: 'a.b(', fixedStrings: true, include: 's1.txt' });
      assert.equal(r.status, 200);
      const lines = rgLines(r);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /a\.b\(/);
    });

    await check('search: caseSensitive distinguishes Hello from hello', async () => {
      const ci = await post('/search', { workspaceId: 'ws1', query: 'Hello', include: 's1.txt' });
      assert.equal(rgLines(ci).length, 2);
      const cs = await post('/search', { workspaceId: 'ws1', query: 'Hello', caseSensitive: true, include: 's1.txt' });
      assert.equal(rgLines(cs).length, 1);
      assert.doesNotMatch(cs.body.matches, /hello again/);
    });

    await check('search: json returns NDJSON lines with a type field', async () => {
      const r = await post('/search', { workspaceId: 'ws1', query: 'Hello', json: true, include: 's1.txt' });
      assert.equal(r.status, 200);
      const lines = rgLines(r);
      assert.ok(lines.length > 0);
      for (const l of lines) assert.equal(typeof JSON.parse(l).type, 'string');
      assert.ok(lines.some((l) => JSON.parse(l).type === 'match'));
    });

    await check('search: a leading-dash query is a pattern, not an rg option', async () => {
      put('dash.txt', 'use -e flag\n');
      const r = await post('/search', { workspaceId: 'ws1', query: '-e', include: 'dash.txt' });
      assert.equal(r.status, 200);
      assert.match(r.body.matches, /use -e flag/);
    });

    await check('search: default output keeps path:line:text shape', async () => {
      const r = await post('/search', { workspaceId: 'ws1', query: 'Hello', include: 's1.txt' });
      assert.equal(r.status, 200);
      assert.deepEqual(rgLines(r).map((l) => l.replace(/^\.?\//, '')), ['s1.txt:2:Hello there', 's1.txt:3:hello again']);
    });
  } finally {
    cleanup();
  }

  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
