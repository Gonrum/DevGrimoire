#!/usr/bin/env node
/*
 * SshFsBackend (Task 6): IDE file operations on an SSH workspace, run against
 * a local stand-in for the remote session (test/lib/local-remote-session.cjs:
 * node:fs in a temp directory, `sh -c` for exec). Also the wiring around it:
 * WorkspaceFsBackends.for (audit rows, upload limit), the controller gate and
 * the verifyRemoteDir hook used when an SSH workspace is created.
 *
 * Loads from dist/; run `npm run build` first. No database, no network.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

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
const { SshFsBackend, isStrictUtf8Text } = loadCompiled('workspaces/fs/ssh-fs-backend.js');
const { WorkspaceFsBackends } = loadCompiled('workspaces/fs/workspace-fs-backends.service.js');
const { WorkspaceFsController } = loadCompiled('workspaces/workspace-fs.controller.js');
const { RequestContext } = loadCompiled('common/request-context.js');
const { SshAuditSchema } = loadCompiled('ssh/schemas/ssh-audit.schema.js');
const { createLocalRemoteSession, unquote } = require('./lib/local-remote-session.cjs');
const { shq } = loadCompiled('common/shell-quote.js');
const mongoose = nm('mongoose');
const { HttpException } = nm('@nestjs/common');

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`ok  ${label}`); }
  catch (err) { failures += 1; console.error(`FAIL ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusOf = (e) => (e && typeof e.getStatus === 'function' ? e.getStatus() : undefined);
const bodyOf = (e) => (e && typeof e.getResponse === 'function' ? e.getResponse() : undefined);
async function rejection(fn) {
  try { await fn(); } catch (e) { return e; }
  throw new Error('expected a rejection');
}
async function rejectsStatus(fn, status, re) {
  const e = await rejection(fn);
  assert.ok(e instanceof HttpException, `expected HttpException, got ${e && e.stack}`);
  assert.equal(statusOf(e), status, `status ${statusOf(e)}: ${JSON.stringify(bodyOf(e))}`);
  const body = bodyOf(e);
  assert.equal(typeof body.error, 'string', 'body.error');
  assert.equal(typeof body.message, 'string', 'body.message');
  if (re) assert.match(body.message, re);
  return e;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const oid = () => new mongoose.Types.ObjectId();
const LIMITS = { editorMaxBytes: 1024, downloadMaxBytes: 1024 * 1024 };
const tmpRoots = [];

/** Fresh temp dir as workspace root + backend over the local fake. */
function setup(opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-sshfs-'));
  tmpRoots.push(base);
  const root = path.join(base, 'srv');
  fs.mkdirSync(root);
  const fake = createLocalRemoteSession(base, RemoteError);
  const audits = [];
  const runs = [];
  const run = (fn, o) => { runs.push(o || {}); return fn(fake.session); };
  const backend = new SshFsBackend(root, run, (action, p, extra) => audits.push({ action, path: p, ...(extra || {}) }), {
    uploadMaxBytes: opts.uploadMaxBytes ?? 64 * 1024,
    downloadIdleMs: opts.downloadIdleMs,
  });
  const f = (rel) => path.join(root, rel);
  const tmpLeft = (dir = root) => fs.readdirSync(dir).filter((n) => n.includes('.dg-tmp-'));
  return { base, root, fake, backend, audits, runs, f, tmpLeft };
}
const collect = (stream) => new Promise((resolve, reject) => {
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  stream.on('end', () => resolve(Buffer.concat(chunks)));
  stream.on('error', reject);
});

// A check that hangs on a promise with no timer left would otherwise end the
// process with exit code 0 and no summary.
let finishedRun = false;
process.on('exit', (code) => {
  if (!finishedRun && code === 0) {
    console.error('FAIL check run ended early (a pending promise never settled)');
    process.exitCode = 1;
  }
});

(async () => {
  // ---- tree -------------------------------------------------------------------
  await check('tree: dotfiles shown, types and sizes, relative paths, .git hidden', async () => {
    const t = setup();
    fs.writeFileSync(t.f('.env'), 'A=1\n');
    fs.mkdirSync(t.f('conf'));
    fs.mkdirSync(t.f('.git'));
    fs.writeFileSync(t.f('conf/app.yml'), 'x: 1\n');
    fs.symlinkSync('conf/app.yml', t.f('link.yml'));
    const top = await t.backend.listDir('.');
    assert.equal(top.truncated, false);
    const byPath = Object.fromEntries(top.entries.map((e) => [e.path, e]));
    assert.deepEqual(byPath['.env'], { path: '.env', type: 'file', size: 4 });
    assert.equal(byPath.conf.type, 'dir');
    assert.equal(byPath['link.yml'].type, 'symlink');
    assert.ok(!byPath['.git'], '.git hidden like in the sidecar');
    const sub = await t.backend.listDir('conf');
    assert.deepEqual(sub.entries.map((e) => e.path), ['conf/app.yml']);
    assert.ok(t.runs.every((o) => o.retryable === true), 'tree is retryable');
  });

  await check('tree: 5001 entries -> 5000 + truncated', async () => {
    const t = setup();
    fs.mkdirSync(t.f('many'));
    for (let i = 0; i < 5001; i += 1) fs.writeFileSync(t.f(`many/f${i}`), '');
    const res = await t.backend.listDir('many');
    assert.equal(res.truncated, true);
    assert.equal(res.entries.length, 5000);
  });

  await check('tree: missing dir -> 404; denied -> 409 "keine Berechtigung auf dem Server: <path>"', async () => {
    const t = setup();
    await rejectsStatus(() => t.backend.listDir('nope'), 404);
    fs.mkdirSync(t.f('secret'));
    t.fake.switches.deny.add(t.f('secret'));
    await rejectsStatus(() => t.backend.listDir('secret'), 409, /^keine Berechtigung auf dem Server: secret$/);
  });

  await check('paths: escaping the root lexically -> 400', async () => {
    const t = setup();
    await rejectsStatus(() => t.backend.listDir('../'), 400);
    await rejectsStatus(() => t.backend.readText('a/../../x', LIMITS), 400);
    await rejectsStatus(() => t.backend.writeText('../x', 'y', { baseHash: null, force: false }, LIMITS), 400);
  });

  // ---- read -------------------------------------------------------------------
  await check('read: content, sha256 hash, size; read audit-free', async () => {
    const t = setup();
    const data = Buffer.from('DB_PASS=geheim\näöü\n');
    fs.writeFileSync(t.f('.env'), data);
    const res = await t.backend.readText('.env', LIMITS);
    assert.equal(res.content, data.toString('utf8'));
    assert.equal(res.hash, sha(data));
    assert.equal(res.size, data.length);
    assert.equal(t.audits.length, 0);
  });

  await check('read: binary -> 415 {size}; over the limit -> 413 {size, limit}; dir -> 400; missing -> 404', async () => {
    const t = setup();
    fs.writeFileSync(t.f('bin'), Buffer.from([0x61, 0x00, 0x62]));
    const e415 = await rejectsStatus(() => t.backend.readText('bin', LIMITS), 415);
    assert.equal(bodyOf(e415).size, 3);
    fs.writeFileSync(t.f('latin1'), Buffer.from([0x66, 0xe4, 0x72]));
    await rejectsStatus(() => t.backend.readText('latin1', LIMITS), 415);
    fs.writeFileSync(t.f('big'), 'x'.repeat(2000));
    const e413 = await rejectsStatus(() => t.backend.readText('big', LIMITS), 413);
    assert.equal(bodyOf(e413).size, 2000);
    assert.equal(bodyOf(e413).limit, 1024);
    fs.mkdirSync(t.f('d'));
    await rejectsStatus(() => t.backend.readText('d', LIMITS), 400);
    await rejectsStatus(() => t.backend.readText('missing', LIMITS), 404);
  });

  await check('read: denied -> 403 "keine Berechtigung auf dem Server"', async () => {
    const t = setup();
    fs.writeFileSync(t.f('shadow'), 'x');
    t.fake.switches.deny.add(t.f('shadow'));
    await rejectsStatus(() => t.backend.readText('shadow', LIMITS), 403, /keine Berechtigung auf dem Server/);
  });

  await check('isStrictUtf8Text matches the sidecar rule', () => {
    assert.equal(isStrictUtf8Text(Buffer.from('ok äöü')), true);
    assert.equal(isStrictUtf8Text(Buffer.from([0x00])), false);
    assert.equal(isStrictUtf8Text(Buffer.from([0xff, 0xfe])), false);
    const lateNul = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x00])]);
    assert.equal(isStrictUtf8Text(lateNul), true, 'NUL only checked in the first 8 KiB');
  });

  // ---- write ------------------------------------------------------------------
  await check('write: wrong baseHash -> 409 + currentHash; force overwrites', async () => {
    const t = setup();
    fs.writeFileSync(t.f('.env'), 'A=1\n');
    const e = await rejectsStatus(() => t.backend.writeText('.env', 'A=2\n', { baseHash: 'deadbeef', force: false }, LIMITS), 409);
    assert.equal(bodyOf(e).currentHash, sha('A=1\n'));
    assert.equal(fs.readFileSync(t.f('.env'), 'utf8'), 'A=1\n');
    const res = await t.backend.writeText('.env', 'A=2\n', { baseHash: 'deadbeef', force: true }, LIMITS);
    assert.equal(res.hash, sha('A=2\n'));
    assert.equal(fs.readFileSync(t.f('.env'), 'utf8'), 'A=2\n');
    assert.deepEqual(t.tmpLeft(), []);
  });

  await check('write: matching baseHash replaces atomically (new inode), mode 0600 stays 0600', async () => {
    const t = setup();
    fs.writeFileSync(t.f('.env'), 'A=1\n', { mode: 0o600 });
    fs.chmodSync(t.f('.env'), 0o600);
    const ino = fs.statSync(t.f('.env')).ino;
    await t.backend.writeText('.env', 'A=3\n', { baseHash: sha('A=1\n'), force: false }, LIMITS);
    const st = fs.statSync(t.f('.env'));
    assert.equal(st.mode & 0o777, 0o600);
    assert.notEqual(st.ino, ino, 'temp file + rename');
    assert.equal(fs.readFileSync(t.f('.env'), 'utf8'), 'A=3\n');
    assert.deepEqual(t.tmpLeft(), []);
  });

  await check('write: new file (baseHash null) -> 0644; baseHash set but file missing -> 409; file exists + null -> 409', async () => {
    const t = setup();
    await t.backend.writeText('new.txt', 'hi', { baseHash: null, force: false }, LIMITS);
    assert.equal(fs.statSync(t.f('new.txt')).mode & 0o777, 0o644);
    const e = await rejectsStatus(() => t.backend.writeText('gone.txt', 'x', { baseHash: sha('x'), force: false }, LIMITS), 409);
    assert.equal(bodyOf(e).currentHash, null);
    assert.ok(!fs.existsSync(t.f('gone.txt')));
    const e2 = await rejectsStatus(() => t.backend.writeText('new.txt', 'x', { baseHash: null, force: false }, LIMITS), 409);
    assert.equal(bodyOf(e2).currentHash, sha('hi'));
  });

  await check('write: missing parent -> 404; target is a directory -> 400; over the editor limit -> 413', async () => {
    const t = setup();
    await rejectsStatus(() => t.backend.writeText('no/dir/x', 'x', { baseHash: null, force: false }, LIMITS), 404);
    fs.mkdirSync(t.f('d'));
    await rejectsStatus(() => t.backend.writeText('d', 'x', { baseHash: null, force: true }, LIMITS), 400);
    const e = await rejectsStatus(() => t.backend.writeText('x', 'y'.repeat(2000), { baseHash: null, force: true }, LIMITS), 413);
    assert.equal(bodyOf(e).limit, 1024);
    await rejectsStatus(() => t.backend.writeText('.', 'x', { baseHash: null, force: true }, LIMITS), 400);
  });

  await check('write: failure after the temp file -> error, no *.dg-tmp-* left, target unchanged', async () => {
    const t = setup();
    fs.writeFileSync(t.f('.env'), 'A=1\n');
    t.fake.switches.failPosixRename = true;
    const e = await rejection(() => t.backend.writeText('.env', 'A=9\n', { baseHash: sha('A=1\n'), force: false }, LIMITS));
    assert.ok(e instanceof HttpException);
    assert.ok(statusOf(e) >= 500, `status ${statusOf(e)}`);
    assert.deepEqual(t.tmpLeft(), []);
    assert.equal(fs.readFileSync(t.f('.env'), 'utf8'), 'A=1\n');
    assert.ok(t.fake.calls.writeFiles.some((p) => /\/\.\.env\.dg-tmp-[0-9a-f]{8}$/.test(p)), 'temp name .<name>.dg-tmp-<8 hex>');
    assert.equal(t.audits.length, 0, 'no audit row for a failed write');
  });

  await check('write: symlink -> target updated, link stays a link', async () => {
    const t = setup();
    fs.mkdirSync(t.f('shared'));
    fs.writeFileSync(t.f('shared/real.env'), 'A=1\n');
    fs.symlinkSync('shared/real.env', t.f('.env'));
    const r = await t.backend.readText('.env', LIMITS);
    await t.backend.writeText('.env', 'A=2\n', { baseHash: r.hash, force: false }, LIMITS);
    assert.equal(fs.lstatSync(t.f('.env')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(t.f('shared/real.env'), 'utf8'), 'A=2\n');
    assert.deepEqual(t.tmpLeft(t.f('shared')), []);
  });

  await check('write fallback: file owned by another uid -> written in place (same inode)', async () => {
    const t = setup();
    fs.writeFileSync(t.f('.env'), 'A=1\n', { mode: 0o640 });
    fs.chmodSync(t.f('.env'), 0o640);
    t.fake.switches.probeUid = fs.statSync(t.f('.env')).uid + 1;
    const ino = fs.statSync(t.f('.env')).ino;
    await t.backend.writeText('.env', 'A=4\n', { baseHash: sha('A=1\n'), force: false }, LIMITS);
    const st = fs.statSync(t.f('.env'));
    assert.equal(st.ino, ino);
    assert.equal(st.mode & 0o777, 0o640);
    assert.equal(fs.readFileSync(t.f('.env'), 'utf8'), 'A=4\n');
    assert.deepEqual(t.tmpLeft(), []);
  });

  await check('write fallback: temp file creation denied -> written in place (same inode)', async () => {
    const t = setup();
    fs.writeFileSync(t.f('.env'), 'A=1\n');
    t.fake.switches.denyCreateIn.add(t.root);
    const ino = fs.statSync(t.f('.env')).ino;
    await t.backend.writeText('.env', 'A=5\n', { baseHash: sha('A=1\n'), force: false }, LIMITS);
    assert.equal(fs.statSync(t.f('.env')).ino, ino);
    assert.equal(fs.readFileSync(t.f('.env'), 'utf8'), 'A=5\n');
    // A new file in a non-writable directory has no fallback.
    await rejectsStatus(() => t.backend.writeText('fresh', 'x', { baseHash: null, force: false }, LIMITS), 403, /keine Berechtigung auf dem Server/);
  });

  await check('write fallback: probe failing (no exec, SFTP-only account) -> in place, save succeeds', async () => {
    const t = setup();
    fs.writeFileSync(t.f('.env'), 'A=1\n');
    const ino = fs.statSync(t.f('.env')).ino;
    t.fake.session.probe = async () => { throw new RemoteError('failure', 'exec refused'); };
    await t.backend.writeText('.env', 'A=7\n', { baseHash: sha('A=1\n'), force: false }, LIMITS);
    assert.equal(fs.statSync(t.f('.env')).ino, ino);
    assert.equal(fs.readFileSync(t.f('.env'), 'utf8'), 'A=7\n');
  });

  await check('write fallback: same uid, other group -> written in place (group kept, same inode)', async () => {
    const t = setup();
    fs.writeFileSync(t.f('.env'), 'A=1\n');
    t.fake.switches.probeGid = fs.statSync(t.f('.env')).gid + 1;
    const ino = fs.statSync(t.f('.env')).ino;
    await t.backend.writeText('.env', 'A=8\n', { baseHash: sha('A=1\n'), force: false }, LIMITS);
    assert.equal(fs.statSync(t.f('.env')).ino, ino);
    assert.equal(fs.readFileSync(t.f('.env'), 'utf8'), 'A=8\n');
    assert.deepEqual(t.tmpLeft(), []);
  });

  await check('replace fallback: target removed, rename fails -> temp file kept and named in the error', async () => {
    const t = setup();
    fs.writeFileSync(t.f('.env'), 'A=1\n');
    t.fake.switches.noPosixRename = true;
    t.fake.switches.failRename = true;
    const e = await rejectsStatus(() => t.backend.writeText('.env', 'A=NEW\n', { baseHash: sha('A=1\n'), force: false }, LIMITS), 500, /Ersetzen fehlgeschlagen; neuer Inhalt liegt in \.\.env\.dg-tmp-[0-9a-f]{8}/);
    const left = t.tmpLeft();
    assert.equal(left.length, 1, 'temp file is the only copy and must stay');
    assert.equal(fs.readFileSync(t.f(left[0]), 'utf8'), 'A=NEW\n');
    assert.ok(bodyOf(e).message.includes(left[0]));
    // Same for an upload with overwrite.
    fs.writeFileSync(t.f('u.bin'), 'old');
    await rejectsStatus(() => t.backend.upload('.', 'u.bin', Readable.from([Buffer.from('fresh')]), { overwrite: true }), 500, /neuer Inhalt liegt in \.u\.bin\.dg-tmp-/);
    const upLeft = t.tmpLeft().filter((n) => n.startsWith('.u.bin.'));
    assert.equal(upLeft.length, 1);
    assert.equal(fs.readFileSync(t.f(upLeft[0]), 'utf8'), 'fresh');
  });

  await check('replace: a failing rename BEFORE the target is removed still cleans the temp file', async () => {
    const t = setup();
    t.fake.switches.noPosixRename = true;
    t.fake.switches.failRename = true;
    await rejection(() => t.backend.upload('.', 'n.bin', Readable.from([Buffer.from('x')]), { overwrite: false }));
    assert.deepEqual(t.tmpLeft(), []);
  });

  await check('write: posixRename unsupported -> replace still works', async () => {
    const t = setup();
    fs.writeFileSync(t.f('.env'), 'A=1\n');
    t.fake.switches.noPosixRename = true;
    await t.backend.writeText('.env', 'A=6\n', { baseHash: sha('A=1\n'), force: false }, LIMITS);
    assert.equal(fs.readFileSync(t.f('.env'), 'utf8'), 'A=6\n');
    await t.backend.writeText('other', 'B', { baseHash: null, force: false }, LIMITS);
    assert.equal(fs.readFileSync(t.f('other'), 'utf8'), 'B');
    assert.deepEqual(t.tmpLeft(), []);
  });

  await check('write: not retryable', async () => {
    const t = setup();
    await t.backend.writeText('w', 'x', { baseHash: null, force: false }, LIMITS);
    assert.ok(t.runs.every((o) => !o.retryable));
  });

  // ---- mkdir / move / delete --------------------------------------------------
  await check('mkdir: recursive; existing -> 409; root -> 400', async () => {
    const t = setup();
    const res = await t.backend.mkdir('a/b/c');
    assert.equal(res.path, 'a/b/c');
    assert.ok(fs.statSync(t.f('a/b/c')).isDirectory());
    await rejectsStatus(() => t.backend.mkdir('a/b/c'), 409);
    await rejectsStatus(() => t.backend.mkdir('.'), 400);
  });

  await check('move: renames; onto an existing target -> 409; missing source -> 404; dir into itself -> 400', async () => {
    const t = setup();
    fs.writeFileSync(t.f('a.txt'), 'a');
    fs.writeFileSync(t.f('b.txt'), 'b');
    await rejectsStatus(() => t.backend.move('a.txt', 'b.txt'), 409);
    assert.equal(fs.readFileSync(t.f('b.txt'), 'utf8'), 'b');
    const res = await t.backend.move('a.txt', 'sub/c.txt');
    assert.deepEqual(res, { from: 'a.txt', to: 'sub/c.txt' });
    assert.equal(fs.readFileSync(t.f('sub/c.txt'), 'utf8'), 'a');
    await rejectsStatus(() => t.backend.move('nope', 'x'), 404);
    fs.mkdirSync(t.f('dir'));
    await rejectsStatus(() => t.backend.move('dir', 'dir/inner'), 400);
  });

  await check('move/remove of the root (".") -> 400', async () => {
    const t = setup();
    await rejectsStatus(() => t.backend.remove('.'), 400);
    await rejectsStatus(() => t.backend.remove('./'), 400);
    await rejectsStatus(() => t.backend.move('.', 'x'), 400);
    await rejectsStatus(() => t.backend.move('x', '.'), 400);
    assert.ok(fs.existsSync(t.root));
  });

  await check('remove: awkward dir name with "-rf" and newline files -> only that dir goes', async () => {
    const t = setup();
    const name = `it's a "dir"`;
    fs.mkdirSync(t.f(name));
    fs.writeFileSync(t.f(`${name}/-rf`), 'x');
    fs.writeFileSync(t.f(`${name}/line\nbreak`), 'x');
    fs.mkdirSync(t.f(`it's a`));
    fs.writeFileSync(t.f(`it's a/keep`), 'k');
    fs.mkdirSync(t.f(`${name}2`));
    await t.backend.remove(name);
    assert.ok(!fs.existsSync(t.f(name)));
    assert.ok(fs.existsSync(t.f(`it's a/keep`)));
    assert.ok(fs.existsSync(t.f(`${name}2`)));
    assert.ok(t.fake.calls.execs.some((c) => c.startsWith('rm -rf -- ')), 'dir removed via rm -rf --');
  });

  await check('remove: file and symlink (link removed, target kept); missing -> 404; rm failure -> 500 with stderr', async () => {
    const t = setup();
    fs.writeFileSync(t.f('f'), 'x');
    await t.backend.remove('f');
    assert.ok(!fs.existsSync(t.f('f')));
    fs.mkdirSync(t.f('target'));
    fs.writeFileSync(t.f('target/keep'), 'k');
    fs.symlinkSync('target', t.f('lnk'));
    await t.backend.remove('lnk');
    assert.ok(!fs.existsSync(t.f('lnk')));
    assert.ok(fs.existsSync(t.f('target/keep')));
    await rejectsStatus(() => t.backend.remove('missing'), 404);
    fs.mkdirSync(t.f('stuck'));
    const realExec = t.fake.session.exec;
    t.fake.session.exec = async () => ({ code: 1, stdout: '', stderr: `rm: cannot remove 'stuck/x': Operation not permitted\n${'y'.repeat(2000)}`, truncated: false });
    const e = await rejectsStatus(() => t.backend.remove('stuck'), 500, /Operation not permitted/);
    assert.ok(bodyOf(e).message.length < 1200, 'stderr shortened');
    t.fake.session.exec = realExec;
  });

  await check('remove dir: own 120 s timeout, never terminated; timeout -> 504 "may still be running" + audit row with errorMsg', async () => {
    const t = setup();
    fs.mkdirSync(t.f('big'));
    fs.writeFileSync(t.f('big/x'), 'x');
    await t.backend.remove('big');
    assert.deepEqual(t.fake.calls.execOpts[0], { timeoutMs: 120_000, terminateOnTimeout: false });
    assert.deepEqual(t.audits.map((a) => [a.action, a.errorMsg]), [['delete', undefined]]);
    fs.mkdirSync(t.f('slow'));
    t.fake.switches.execTimeout = true;
    const e = await rejectsStatus(() => t.backend.remove('slow'), 504, /möglicherweise noch weiter/);
    assert.match(bodyOf(e).message, /slow/);
    assert.equal(t.audits.length, 2, 'failed delete audited');
    assert.equal(t.audits[1].action, 'delete');
    assert.equal(t.audits[1].path, t.f('slow'));
    assert.match(t.audits[1].errorMsg, /möglicherweise noch weiter/);
  });

  await check('remove dir: rm exit != 0 -> 500 and an audit row with errorMsg; 404 before rm -> no row', async () => {
    const t = setup();
    fs.mkdirSync(t.f('stuck'));
    t.fake.session.exec = async () => ({ code: 1, stdout: '', stderr: 'rm: Operation not permitted', truncated: false });
    await rejectsStatus(() => t.backend.remove('stuck'), 500);
    assert.equal(t.audits.length, 1);
    assert.match(t.audits[0].errorMsg, /rm failed \(exit 1\)/);
    await rejectsStatus(() => t.backend.remove('missing'), 404);
    assert.equal(t.audits.length, 1, 'nothing was sent: no audit row');
  });

  // ---- upload -----------------------------------------------------------------
  await check('upload: writes via temp file; returns path/size; mode 0644', async () => {
    const t = setup();
    fs.mkdirSync(t.f('up'));
    const res = await t.backend.upload('up', 'data.bin', Readable.from([Buffer.from('abc'), Buffer.from('def')]), { size: 6, overwrite: false });
    assert.deepEqual(res, { path: 'up/data.bin', size: 6 });
    assert.equal(fs.readFileSync(t.f('up/data.bin'), 'utf8'), 'abcdef');
    assert.equal(fs.statSync(t.f('up/data.bin')).mode & 0o777, 0o644);
    assert.deepEqual(t.tmpLeft(t.f('up')), []);
    const root = await t.backend.upload('.', 'top.txt', Readable.from([Buffer.from('t')]), { overwrite: false });
    assert.equal(root.path, 'top.txt');
  });

  await check('upload: existing target without overwrite -> 409; with overwrite replaced', async () => {
    const t = setup();
    fs.writeFileSync(t.f('x.txt'), 'old');
    await rejectsStatus(() => t.backend.upload('.', 'x.txt', Readable.from([Buffer.from('new')]), { overwrite: false }), 409);
    assert.equal(fs.readFileSync(t.f('x.txt'), 'utf8'), 'old');
    t.fake.switches.noPosixRename = true;
    await t.backend.upload('.', 'x.txt', Readable.from([Buffer.from('new')]), { overwrite: true });
    assert.equal(fs.readFileSync(t.f('x.txt'), 'utf8'), 'new');
    assert.deepEqual(t.tmpLeft(), []);
  });

  await check('upload overwrite: file of another owner keeps its inode (in place); own file is replaced', async () => {
    const t = setup();
    fs.writeFileSync(t.f('o.txt'), 'old content');
    fs.chmodSync(t.f('o.txt'), 0o640);
    const ino = fs.statSync(t.f('o.txt')).ino;
    t.fake.switches.probeUid += 1; // the file now "belongs" to someone else
    await t.backend.upload('.', 'o.txt', Readable.from([Buffer.from('new')]), { size: 3, overwrite: true });
    assert.equal(fs.readFileSync(t.f('o.txt'), 'utf8'), 'new');
    assert.equal(fs.statSync(t.f('o.txt')).ino, ino, 'inode unchanged');
    assert.equal(fs.statSync(t.f('o.txt')).mode & 0o777, 0o640, 'mode unchanged');
    assert.deepEqual(t.tmpLeft(), []);
    // Probe failure counts as "other owner" as well.
    t.fake.switches.probeUid -= 1;
    const realProbe = t.fake.session.probe;
    t.fake.session.probe = async () => { throw new RemoteError('failure', 'no exec'); };
    await t.backend.upload('.', 'o.txt', Readable.from([Buffer.from('again')]), { overwrite: true });
    assert.equal(fs.statSync(t.f('o.txt')).ino, ino, 'inode unchanged on probe failure');
    assert.equal(fs.readFileSync(t.f('o.txt'), 'utf8'), 'again');
    t.fake.session.probe = realProbe;
    // Same owner: temp + rename as before (new inode).
    await t.backend.upload('.', 'o.txt', Readable.from([Buffer.from('mine')]), { overwrite: true });
    assert.notEqual(fs.statSync(t.f('o.txt')).ino, ino);
    assert.equal(fs.readFileSync(t.f('o.txt'), 'utf8'), 'mine');
    assert.deepEqual(t.tmpLeft(), []);
  });

  await check('upload overwrite in place: body over the limit -> 413, target untouched', async () => {
    const t = setup({ uploadMaxBytes: 10 });
    fs.writeFileSync(t.f('o.txt'), 'keep');
    t.fake.switches.probeUid += 1;
    async function* gen() { for (let i = 0; i < 5; i += 1) yield Buffer.alloc(4, 0x61); }
    await rejectsStatus(() => t.backend.upload('.', 'o.txt', Readable.from(gen()), { overwrite: true }), 413);
    await sleep(20);
    assert.equal(fs.readFileSync(t.f('o.txt'), 'utf8'), 'keep');
    assert.deepEqual(t.tmpLeft(), []);
  });

  await check('upload: known size over the limit -> 413 {limit} before writing', async () => {
    const t = setup({ uploadMaxBytes: 10 });
    const e = await rejectsStatus(() => t.backend.upload('.', 'big', Readable.from([Buffer.alloc(11)]), { size: 11, overwrite: false }), 413);
    assert.equal(bodyOf(e).limit, 10);
    assert.equal(t.fake.calls.writeStreams, 0);
  });

  await check('upload: unknown size streaming past the limit -> 413, no temp file, no target', async () => {
    const t = setup({ uploadMaxBytes: 10 });
    async function* gen() { for (let i = 0; i < 5; i += 1) { yield Buffer.alloc(4, 0x61); await sleep(2); } }
    const e = await rejectsStatus(() => t.backend.upload('.', 'big', Readable.from(gen()), { overwrite: false }), 413);
    assert.equal(bodyOf(e).limit, 10);
    await sleep(20);
    assert.deepEqual(t.tmpLeft(), []);
    assert.ok(!fs.existsSync(t.f('big')));
  });

  await check('upload: source aborted mid-stream -> error, no temp file, no target', async () => {
    const t = setup();
    const src = new Readable({ read() {} });
    src.push(Buffer.from('part'));
    setTimeout(() => src.destroy(new Error('aborted')), 10);
    await rejection(() => t.backend.upload('.', 'half', src, { overwrite: false }));
    await sleep(20);
    assert.deepEqual(t.tmpLeft(), []);
    assert.ok(!fs.existsSync(t.f('half')));
  });

  await check('upload: size mismatch -> 400, no file; missing dir -> 404', async () => {
    const t = setup();
    await rejectsStatus(() => t.backend.upload('.', 'm', Readable.from([Buffer.from('abc')]), { size: 5, overwrite: false }), 400);
    assert.ok(!fs.existsSync(t.f('m')));
    assert.deepEqual(t.tmpLeft(), []);
    await rejectsStatus(() => t.backend.upload('nodir', 'm', Readable.from([Buffer.from('abc')]), { overwrite: false }), 404);
  });

  // ---- download ---------------------------------------------------------------
  await check('download: exact bytes, size; over the download limit -> 413; dir -> 400', async () => {
    const t = setup();
    const data = crypto.randomBytes(200 * 1024);
    fs.writeFileSync(t.f('app.log'), data);
    const { stream, size } = await t.backend.readStream('app.log', LIMITS);
    assert.equal(size, data.length);
    const got = await collect(stream);
    assert.ok(got.equals(data));
    await rejectsStatus(() => t.backend.readStream('app.log', { ...LIMITS, downloadMaxBytes: 1000 }), 413);
    fs.mkdirSync(t.f('d'));
    await rejectsStatus(() => t.backend.readStream('d', LIMITS), 400);
    assert.ok(t.runs.every((o) => !o.retryable), 'streams are not retryable');
    assert.equal(t.audits.length, 0);
  });

  await check('download: destroy() mid-read closes the underlying read', async () => {
    const t = setup();
    fs.writeFileSync(t.f('big.log'), crypto.randomBytes(2 * 1024 * 1024));
    const { stream } = await t.backend.readStream('big.log', { ...LIMITS, downloadMaxBytes: 10 * 1024 * 1024 });
    await new Promise((resolve) => stream.once('data', resolve));
    stream.pause();
    stream.destroy();
    await sleep(30);
    const under = t.fake.calls.readStreams.at(-1);
    assert.equal(under.destroyed, true, 'SFTP read stream destroyed');
  });

  await check('download: a growing file sends only the size at the start', async () => {
    const t = setup();
    fs.writeFileSync(t.f('grow.log'), 'a'.repeat(1000));
    const { stream, size } = await t.backend.readStream('grow.log', LIMITS);
    fs.appendFileSync(t.f('grow.log'), 'b'.repeat(5000));
    const got = await collect(stream);
    assert.equal(size, 1000);
    assert.equal(got.length, 1000);
  });

  await check('download: a consumer pausing longer than the idle limit is not idle; full file arrives', async () => {
    const t = setup({ downloadIdleMs: 40 });
    const data = crypto.randomBytes(400 * 1024);
    fs.writeFileSync(t.f('slow.log'), data);
    const { stream } = await t.backend.readStream('slow.log', LIMITS);
    const chunks = [];
    let errored = null;
    stream.on('error', (e) => { errored = e; });
    await new Promise((resolve) => stream.once('data', (c) => { chunks.push(c); resolve(); }));
    stream.pause();
    await sleep(200);
    assert.equal(errored, null, 'backpressure must not trip the idle timer');
    const restP = collect(stream);
    stream.resume();
    const rest = await restP;
    assert.ok(Buffer.concat([...chunks, rest]).equals(data));
  });

  await check('download: no bytes for the idle limit -> stream errors with timeout, source destroyed', async () => {
    const t = setup({ downloadIdleMs: 40 });
    fs.writeFileSync(t.f('stall'), 'x'.repeat(10));
    t.fake.switches.stallRead = true;
    const { stream } = await t.backend.readStream('stall', LIMITS);
    const err = await new Promise((resolve) => { stream.on('error', resolve); stream.resume(); });
    assert.equal(err.code, 'timeout');
    assert.equal(t.fake.calls.readStreams.at(-1).destroyed, true);
  });

  // ---- the fake itself --------------------------------------------------------
  await check('fake exec: unknown command and rm outside the temp dir both throw, nothing runs', async () => {
    const t = setup();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-sshfs-outside-'));
    fs.writeFileSync(path.join(outside, 'keep'), 'k');
    try {
      await assert.rejects(() => t.fake.session.exec('echo hi'), /command not allowed/);
      await assert.rejects(() => t.fake.session.exec(`rm -rf -- ${shq(outside)}`), /outside the temp dir/);
      await assert.rejects(() => t.fake.session.exec(`rm -rf -- ${shq(t.root + '/../../x')}`), /outside the temp dir/);
      await assert.rejects(() => t.fake.session.exec(`rm -rf -- ${shq(t.f('a'))} ${shq(outside)}`), /command not allowed/);
      await assert.rejects(() => t.fake.session.exec(`rm -rf -- ${shq(t.f('a'))}; rm -rf ${shq(outside)}`), /command not allowed/);
      assert.ok(fs.existsSync(path.join(outside, 'keep')));
      assert.equal(unquote(shq(`it's a "dir"`)), `it's a "dir"`);
      assert.equal(t.fake.calls.execs.length, 0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // ---- audit ------------------------------------------------------------------
  await check('audit: one row each for write/upload/mkdir/move/delete, none for read/tree/download; never content', async () => {
    const t = setup();
    await t.backend.writeText('.env', 'SECRET=topsecret\n', { baseHash: null, force: false }, LIMITS);
    await t.backend.upload('.', 'u.txt', Readable.from([Buffer.from('payload')]), { overwrite: false });
    await t.backend.mkdir('m');
    await t.backend.move('u.txt', 'm/u.txt');
    await t.backend.remove('m');
    await t.backend.readText('.env', LIMITS);
    await t.backend.listDir('.');
    const { stream } = await t.backend.readStream('.env', LIMITS);
    await collect(stream);
    assert.deepEqual(t.audits.map((a) => a.action), ['write', 'upload', 'mkdir', 'move', 'delete']);
    assert.equal(t.audits[0].path, t.f('.env'));
    assert.equal(t.audits[0].bytes, 17);
    assert.equal(t.audits[1].bytes, 7);
    assert.equal(t.audits[3].path, `${t.f('u.txt')} -> ${t.f('m/u.txt')}`);
    assert.ok(!JSON.stringify(t.audits).includes('topsecret'));
    assert.ok(!JSON.stringify(t.audits).includes('payload'));
  });

  await check('remote error codes -> HTTP: timeout 504, disconnected 502, failure 500', async () => {
    for (const [code, status] of [['timeout', 504], ['disconnected', 502], ['failure', 500], ['exists', 409], ['too_large', 413]]) {
      const run = async () => { throw new RemoteError(code, 'boom'); };
      const b = new SshFsBackend('/srv/app', run, () => undefined, { uploadMaxBytes: 10 });
      await rejectsStatus(() => b.readText('x', LIMITS), status);
    }
  });

  await check('constructor rejects a root that is not absolute or is "/"', () => {
    assert.throws(() => new SshFsBackend('/', async () => undefined, () => undefined, { uploadMaxBytes: 1 }));
    assert.throws(() => new SshFsBackend('srv', async () => undefined, () => undefined, { uploadMaxBytes: 1 }));
  });

  // ---- wiring -----------------------------------------------------------------
  const WS_ID = oid();
  const CONN_ID = oid();
  const USER_ID = oid().toString();
  const sshWs = () => ({ _id: WS_ID, projectId: oid(), status: 'active', location: 'ssh', sshConnectionId: CONN_ID, remotePath: '/srv/app' });
  const connection = { _id: CONN_ID, label: 'prod', maxUploadBytes: 1234 };
  function makeWiring() {
    const t = setup();
    const audits = [];
    const sessionCalls = [];
    const dropped = [];
    let established = false;
    const sessions = {
      withSession: async (wsId, connId, fn, opts = {}) => {
        sessionCalls.push({ wsId, connId, opts });
        if (!established) { established = true; if (opts.onConnect) opts.onConnect(); }
        return fn(t.fake.session);
      },
      drop: (key) => dropped.push(key),
    };
    const connector = {
      resolveUploadLimit: async (c) => c.maxUploadBytes,
      writeAudit: (entry) => { audits.push(entry); return Promise.resolve(); },
    };
    const access = { resolve: async () => connection, calls: 0 };
    const workspaces = {};
    const backends = new WorkspaceFsBackends({ ensureDir: async () => { throw new Error('no sidecar for ssh'); } }, sessions, connector, access, workspaces);
    return { t, audits, sessionCalls, dropped, backends, workspaces, sessions };
  }
  const asUser = (fn) => RequestContext.run({ userId: USER_ID, username: 'u', role: 'admin' }, undefined, fn);

  await check('backends.for(ssh): SshFsBackend bound to the workspace; connect + write audit rows with ide/workspace/user', async () => {
    const w = makeWiring();
    const ws = { ...sshWs(), remotePath: w.t.root };
    const backend = await asUser(() => w.backends.for(ws, connection));
    assert.ok(backend instanceof SshFsBackend);
    await asUser(() => backend.writeText('.env', 'A=1\n', { baseHash: null, force: false }, LIMITS));
    await asUser(() => backend.readText('.env', LIMITS));
    assert.ok(w.sessionCalls.every((c) => c.wsId === String(WS_ID) && c.connId === String(CONN_ID)));
    assert.deepEqual(w.audits.map((a) => a.action), ['connect', 'write']);
    for (const a of w.audits) {
      assert.equal(a.sourceContext, 'ide');
      assert.equal(a.userId, USER_ID);
      assert.equal(a.workspaceId, String(WS_ID));
      assert.equal(String(a.connectionId), String(CONN_ID));
      assert.ok(!('content' in a));
    }
    assert.equal(w.audits[1].remotePath, path.join(w.t.root, '.env'));
    assert.equal(w.audits[1].bytes, 4);
  });

  await check('backends.for(ssh): upload limit from resolveUploadLimit(connection)', async () => {
    const w = makeWiring();
    const ws = { ...sshWs(), remotePath: w.t.root };
    const backend = await asUser(() => w.backends.for(ws, connection));
    const e = await rejectsStatus(() => backend.upload('.', 'x', Readable.from([Buffer.alloc(1)]), { size: 2000, overwrite: false }), 413);
    assert.equal(bodyOf(e).limit, 1234);
  });

  await check('audit schema: ide action/source values accepted; ide requires userId and workspaceId', () => {
    const Model = mongoose.models.SshAuditCheck || mongoose.model('SshAuditCheck', SshAuditSchema);
    for (const action of ['write', 'mkdir', 'move', 'delete', 'connect', 'upload']) {
      const doc = new Model({ connectionId: oid(), action, sourceContext: 'ide', userId: oid(), workspaceId: oid() });
      assert.equal(doc.validateSync(), undefined, action);
    }
    const noWs = new Model({ connectionId: oid(), action: 'write', sourceContext: 'ide', userId: oid() });
    assert.ok(noWs.validateSync()?.errors.workspaceId, 'workspaceId required for ide');
    const noUser = new Model({ connectionId: oid(), action: 'write', sourceContext: 'ide', workspaceId: oid() });
    assert.ok(noUser.validateSync()?.errors.userId, 'userId required for ide');
  });

  await check('controller gate: ssh workspace -> access.resolve, then backends.for(ws, connection); never ensureDir', async () => {
    const ws = sshWs();
    let sidecar = 0;
    const client = new Proxy({}, { get: () => async () => { sidecar += 1; return {}; } });
    const svc = { findById: async () => ws, touchThrottled() {} };
    const seen = [];
    const access = { resolve: async (x) => { seen.push(['resolve', String(x._id)]); return connection; } };
    const backends = new WorkspaceFsBackends(client);
    backends.for = async (x, c) => { seen.push(['for', String(x._id), c && c.label]); return { listDir: async () => ({ entries: [], truncated: false }) }; };
    const limits = { get: async () => ({ editorMaxBytes: 1, downloadMaxBytes: 1 }) };
    const ctrl = new WorkspaceFsController(svc, backends, { create: async () => undefined }, limits, { issue: () => 't', consume: () => null }, { resolve: async () => undefined }, access);
    await asUser(() => ctrl.tree(String(ws._id), '.'));
    assert.deepEqual(seen, [['resolve', String(WS_ID)], ['for', String(WS_ID), 'prod']]);
    assert.equal(sidecar, 0);
    const denied = { resolve: async () => { throw new (nm('@nestjs/common').ConflictException)('SSH-Verbindung dieser Werkstatt existiert nicht mehr'); } };
    const ctrl2 = new WorkspaceFsController(svc, backends, { create: async () => undefined }, limits, { issue: () => 't', consume: () => null }, { resolve: async () => undefined }, denied);
    await rejectsStatus(() => asUser(() => ctrl2.tree(String(ws._id), '.')), 409, /existiert nicht mehr/);
  });

  await check('verifyRemoteDir: registered on init; dir ok; missing -> 400 with label; file -> 400; temp session dropped', async () => {
    const w = makeWiring();
    w.backends.onModuleInit();
    assert.equal(typeof w.workspaces.verifyRemoteDir, 'function');
    fs.mkdirSync(w.t.f('app'));
    fs.writeFileSync(w.t.f('file'), 'x');
    await w.workspaces.verifyRemoteDir(connection, w.t.f('app'));
    const e = await rejectsStatus(() => w.workspaces.verifyRemoteDir(connection, w.t.f('nope')), 400);
    assert.match(bodyOf(e).message, /Verzeichnis .*nope.* existiert auf prod nicht/);
    await rejectsStatus(() => w.workspaces.verifyRemoteDir(connection, w.t.f('file')), 400, /kein Verzeichnis/);
    assert.equal(w.dropped.length, 3, 'temporary session dropped every time');
    const keys = w.sessionCalls.map((c) => c.wsId);
    assert.ok(keys.every((k) => k !== String(WS_ID) && k.startsWith('verify:')));
    assert.ok(w.dropped.every((k) => keys.includes(k)));
    assert.equal(w.audits.length, 0);
  });

  await check('verifyRemoteDir: connect failure (HttpException) passes through; timeout -> 504', async () => {
    const w = makeWiring();
    w.backends.onModuleInit();
    w.sessions.withSession = async () => { throw new HttpException({ error: 'tofu_not_accepted', message: 'SSH-Verbindung "prod": Fingerprint nicht akzeptiert' }, 409); };
    await rejectsStatus(() => w.workspaces.verifyRemoteDir(connection, '/srv/x'), 409, /Fingerprint/);
    w.sessions.withSession = async () => { throw new RemoteError('timeout', 'stat timed out'); };
    await rejectsStatus(() => w.workspaces.verifyRemoteDir(connection, '/srv/x'), 504);
    assert.equal(w.dropped.length, 2);
  });

  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
  finishedRun = true;
  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
})();
