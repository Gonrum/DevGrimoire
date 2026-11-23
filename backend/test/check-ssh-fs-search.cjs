#!/usr/bin/env node
/*
 * SshFsBackend search + git status (Task 7), run against the local stand-in
 * for the remote session (test/lib/local-remote-session.cjs). The fake only
 * runs allowlisted `cd -- '<root>' && rg|grep|git ...` shapes.
 *
 * Loads from dist/; run `npm run build` first. No database, no network.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert/strict');
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
require(path.resolve(__dirname, '..', 'node_modules', 'reflect-metadata'));

const { RemoteError } = loadCompiled('workspaces/fs/remote-session.js');
const { SshFsBackend } = loadCompiled('workspaces/fs/ssh-fs-backend.js');
const parse = loadCompiled('workspaces/workspace-search-parse.js');
const { createLocalRemoteSession } = require('./lib/local-remote-session.cjs');
const { HttpException } = nm('@nestjs/common');

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`ok  ${label}`); }
  catch (err) { failures += 1; console.error(`FAIL ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const statusOf = (e) => (e && typeof e.getStatus === 'function' ? e.getStatus() : undefined);
async function rejectsStatus(fn, status, re) {
  let e;
  try { await fn(); } catch (x) { e = x; }
  assert.ok(e instanceof HttpException, `expected HttpException, got ${e && e.stack}`);
  assert.equal(statusOf(e), status, JSON.stringify(e.getResponse()));
  const body = e.getResponse();
  assert.equal(typeof body.error, 'string');
  assert.equal(typeof body.message, 'string');
  if (re) assert.match(body.message, re);
}
const tmpRoots = [];
function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-sshsearch-'));
  tmpRoots.push(base);
  const root = path.join(base, 'srv');
  fs.mkdirSync(root);
  const fake = createLocalRemoteSession(base, RemoteError);
  const runs = [];
  const run = (fn, o) => { runs.push(o || {}); return fn(fake.session); };
  const backend = new SshFsBackend(root, run, () => undefined, { uploadMaxBytes: 1024 });
  const f = (rel) => path.join(root, rel);
  return { base, root, fake, backend, runs, f };
}
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
const hasRg = (() => { try { execFileSync('rg', ['--version'], { stdio: 'pipe' }); return true; } catch { return false; } })();
const q = (query, extra = {}) => ({ query, regex: false, caseSensitive: false, ...extra });
const hits = (res) => res.matches.map((m) => `${m.path}:${m.line}`).sort();

function seed(t) {
  fs.mkdirSync(t.f('a b'), { recursive: true });
  fs.mkdirSync(t.f('src'));
  fs.mkdirSync(t.f('.git'));
  fs.writeFileSync(t.f('.git/config'), 'needle in git\n');
  fs.writeFileSync(t.f("a b/it's.txt"), 'one\nthe Needle here\nthree\n');
  fs.writeFileSync(t.f('src/x.ts'), 'const needle = 1;\n');
  fs.writeFileSync(t.f('src/y.js'), 'needle();\n');
  fs.writeFileSync(t.f('c:d.txt'), 'x needle\n');
  fs.writeFileSync(t.f('.env'), 'TOKEN=needle\n');
  fs.writeFileSync(t.f('bin.dat'), Buffer.from([0, 1, 2, 110, 101, 101, 100, 108, 101]));
}

(async () => {
  // ---- parseGrepOutput --------------------------------------------------------
  await check('parseGrepOutput: path with colon and space, column, ./ stripped', () => {
    const out = './a b/x:y.txt\0' + '12:the Needle here\n' + './z.txt\0' + '3:needle needle\n';
    const r = parse.parseGrepOutput(out, { query: 'needle', regex: false, caseSensitive: false }, 2000);
    assert.deepEqual(r, {
      matches: [
        { path: 'a b/x:y.txt', line: 12, column: 5, text: 'the Needle here' },
        { path: 'z.txt', line: 3, column: 1, text: 'needle needle' },
      ],
      truncated: false,
    });
  });
  await check('parseGrepOutput: case-sensitive column, regex -> column 1, limit -> truncated', () => {
    const out = './a\0' + '1:Needle needle\n';
    const cs = parse.parseGrepOutput(out, { query: 'needle', regex: false, caseSensitive: true }, 10);
    assert.equal(cs.matches[0].column, 8);
    const re = parse.parseGrepOutput(out, { query: 'ne+dle', regex: true, caseSensitive: false }, 10);
    assert.equal(re.matches[0].column, 1);
    const many = Array.from({ length: 5 }, (_, i) => `./f\0${i + 1}:needle\n`).join('');
    const lim = parse.parseGrepOutput(many, { query: 'needle', regex: false, caseSensitive: false }, 3);
    assert.equal(lim.matches.length, 3);
    assert.equal(lim.truncated, true);
  });
  await check('parseGrepOutput: long text cut to 300, garbage lines skipped', () => {
    const out = 'noise without nul\n' + './f\0' + `1:${'x'.repeat(500)}\n` + './g\0not-a-number:foo\n';
    const r = parse.parseGrepOutput(out, { query: 'x', regex: false, caseSensitive: true }, 10);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].text.length, 300);
  });

  // ---- relativizeStatus -------------------------------------------------------
  await check('relativizeStatus: strips prefix, drops outside paths, empty prefix = identity', () => {
    const parsed = { branch: 'main', changed: [
      { path: 'sub/a.txt', code: ' M' }, { path: 'other/b.txt', code: '??' },
      { path: 'sub/deep/c.txt', code: 'R ' }, { path: 'subway/d.txt', code: ' M' }, { path: 'top.txt', code: ' M' },
    ] };
    const r = parse.relativizeStatus(parsed, 'sub/');
    assert.equal(r.branch, 'main');
    assert.deepEqual(r.changed.map((c) => c.path), ['a.txt', 'deep/c.txt']);
    assert.deepEqual(parse.relativizeStatus(parsed, ''), parsed);
  });

  // ---- grep path --------------------------------------------------------------
  await check('grep: finds matches in a path with space+apostrophe and colon, .git skipped, binary skipped', async () => {
    const t = setup(); seed(t);
    const res = await t.backend.search(q('needle'));
    assert.equal(res.engine, 'grep');
    assert.deepEqual(hits(res), ['.env:1', "a b/it's.txt:2", 'c:d.txt:1', 'src/x.ts:1', 'src/y.js:1']);
    const m = res.matches.find((x) => x.path === "a b/it's.txt");
    assert.equal(m.column, 5);
    assert.equal(res.truncated, false);
    assert.ok(t.runs.every((o) => o.retryable === true), 'search is retryable');
  });
  await check('grep: case-sensitive, include/exclude, regex', async () => {
    const t = setup(); seed(t);
    assert.deepEqual(hits(await t.backend.search(q('Needle', { caseSensitive: true }))), ["a b/it's.txt:2"]);
    assert.deepEqual(hits(await t.backend.search(q('needle', { include: ['*.ts'] }))), ['src/x.ts:1']);
    assert.deepEqual(hits(await t.backend.search(q('needle', { exclude: ['*.ts', '*.js', '*.txt', '.env'] }))), []);
    assert.deepEqual(hits(await t.backend.search(q('ne+dle\\(\\)', { regex: true }))), ['src/y.js:1']);
  });
  await check('grep: no match -> empty; invalid regex -> 400 with grep message', async () => {
    const t = setup(); seed(t);
    assert.deepEqual(await t.backend.search(q('zzzzz')), { matches: [], truncated: false, engine: 'grep' });
    await rejectsStatus(() => t.backend.search(q('(unclosed', { regex: true })), 400, /\S/);
  });
  await check('injection probes: no file `pwned` anywhere', async () => {
    const t = setup(); seed(t);
    for (const probe of ['$(touch pwned)', "'; touch pwned; '", '`touch pwned`', '"; touch pwned; "']) {
      for (const rg of [false, true]) {
        if (rg && !hasRg) continue;
        t.fake.switches.probeRg = rg;
        const res = await t.backend.search(q(probe, { include: [probe] }));
        assert.equal(res.matches.length, 0);
        const res2 = await t.backend.search(q(probe, { exclude: [probe] }));
        assert.equal(res2.matches.length, 0);
      }
    }
    fs.writeFileSync(t.f('lit.txt'), "x $(touch pwned) '; touch pwned; '\n");
    const lit = await t.backend.search(q('$(touch pwned)'));
    assert.deepEqual(hits(lit), ['lit.txt:1']);
    for (const dir of [t.root, t.base, process.cwd(), os.tmpdir()]) {
      assert.ok(!fs.existsSync(path.join(dir, 'pwned')), `pwned in ${dir}`);
    }
  });
  await check('fake guard: commands outside the allowlist / with unguarded root still throw', async () => {
    const t = setup();
    const s = t.fake.session;
    await assert.rejects(() => s.exec('ls'), /not allowed/);
    await assert.rejects(() => s.exec(`cd -- '/etc' && grep -rnIZ -e 'x' -- .`), /outside the temp dir/);
    await assert.rejects(() => s.exec(`cd -- '${t.root}' && grep -rnIZ -e 'x' -- . ; touch pwned`), /not allowed|bare word/);
    await assert.rejects(() => s.exec(`cd -- '${t.root}' && cat -- 'x'`), /not allowed/);
  });
  await check('timeout -> empty, truncated; output cap -> partial line dropped, truncated', async () => {
    const t = setup(); seed(t);
    t.fake.switches.execTimeout = true;
    assert.deepEqual(await t.backend.search(q('needle')), { matches: [], truncated: true, engine: 'grep' });
    t.fake.switches.execTimeout = false;
    // Force a tiny cap through the fake: wrap exec.
    const orig = t.fake.session.exec;
    t.fake.session.exec = (c, o) => orig(c, { ...o, maxOutputBytes: 40 });
    const res = await t.backend.search(q('needle'));
    assert.equal(res.truncated, true);
    for (const m of res.matches) assert.ok(m.path && m.line > 0 && /needle/i.test(m.text));
  });
  await check('search command: bounded by `timeout -s TERM 18` when the server has it, bare otherwise', async () => {
    const t = setup(); seed(t);
    const cd = `cd -- '${t.root}' && `;
    for (const rg of [false, true]) {
      if (rg && !hasRg) continue;
      t.fake.switches.probeRg = rg;
      t.fake.switches.probeTimeout = true;
      const withT = await t.backend.search(q('needle'));
      assert.ok(withT.matches.length > 0);
      const last = t.fake.calls.execs[t.fake.calls.execs.length - 1];
      assert.ok(last.startsWith(`${cd}timeout -s TERM 18 ${rg ? 'rg ' : 'grep '}`), last);
      t.fake.switches.probeTimeout = false;
      const without = await t.backend.search(q('needle'));
      assert.deepEqual(hits(without), hits(withT));
      const bare = t.fake.calls.execs[t.fake.calls.execs.length - 1];
      assert.ok(bare.startsWith(`${cd}${rg ? 'rg ' : 'grep '}`), bare);
    }
  });
  await check('rg command on SSH: --hidden with .git excluded', async () => {
    const t = setup(); seed(t);
    t.fake.switches.probeRg = true;
    t.fake.switches.probeTimeout = false;
    // The fake only checks the shape; without rg installed the command may fail, the string is what counts.
    try { await t.backend.search(q('needle')); } catch { /* rg missing locally */ }
    const cmd = t.fake.calls.execs[t.fake.calls.execs.length - 1];
    assert.ok(cmd.includes(" rg --json --max-count 50 --max-columns 300 --hidden --glob '!.git' "), cmd);
  });
  await check('exit 124 (server-side timeout) -> empty, truncated; without the wrapper 124 is a failure', async () => {
    const t = setup(); seed(t);
    t.fake.session.exec = async () => ({ code: 124, stdout: './a\0' + '1:needle\n', stderr: '', truncated: false });
    assert.deepEqual(await t.backend.search(q('needle')), { matches: [], truncated: true, engine: 'grep' });
    t.fake.switches.probeTimeout = false;
    await rejectsStatus(() => t.backend.search(q('needle')), 500, /exit 124/);
  });
  await check('2000 match cap -> truncated', async () => {
    const t = setup();
    fs.mkdirSync(t.f('many'));
    for (let i = 0; i < 60; i += 1) {
      fs.writeFileSync(t.f(`many/f${i}.txt`), Array.from({ length: 50 }, () => 'needle').join('\n') + '\n');
    }
    const res = await t.backend.search(q('needle'));
    assert.equal(res.matches.length, 2000);
    assert.equal(res.truncated, true);
  });

  // ---- rg path ----------------------------------------------------------------
  if (!hasRg) {
    console.log('skip rg parity + rg checks: rg not installed locally');
  } else {
    await check('rg: same paths and lines as grep, engine rg', async () => {
      const t = setup(); seed(t);
      const g = await t.backend.search(q('needle'));
      t.fake.switches.probeRg = true;
      const r = await t.backend.search(q('needle'));
      assert.equal(r.engine, 'rg');
      // rg on SSH searches hidden files (.env) and still skips .git and binaries, like grep.
      assert.deepEqual(hits(r), hits(g));
      assert.ok(hits(r).includes('.env:1'), 'dotfile found by rg');
      assert.ok(!hits(r).some((h) => h.startsWith('.git/')), '.git skipped by rg');
    });
    await check('rg: include/exclude/case, invalid regex -> 400', async () => {
      const t = setup(); seed(t);
      t.fake.switches.probeRg = true;
      assert.deepEqual(hits(await t.backend.search(q('needle', { include: ['*.ts'] }))), ['src/x.ts:1']);
      assert.deepEqual(hits(await t.backend.search(q('Needle', { caseSensitive: true }))), ["a b/it's.txt:2"]);
      assert.deepEqual(hits(await t.backend.search(q('needle', { exclude: ['*.ts', '*.js', '*.txt', '.env'] }))), []);
      await rejectsStatus(() => t.backend.search(q('(unclosed', { regex: true })), 400, /\S/);
    });
  }

  // ---- status -----------------------------------------------------------------
  await check('status: subdir root -> paths relative to root, outside changes dropped', async () => {
    const t = setup();
    fs.mkdirSync(t.f('proj'));
    git(t.root, 'init', '-q', '-b', 'main');
    fs.writeFileSync(t.f('proj/a.txt'), '1\n');
    fs.writeFileSync(t.f('outside.txt'), '1\n');
    git(t.root, 'add', '.');
    git(t.root, 'commit', '-qm', 'init');
    fs.writeFileSync(t.f('proj/a.txt'), '2\n');
    fs.writeFileSync(t.f('proj/new file é.txt'), 'n\n');
    fs.writeFileSync(t.f('outside.txt'), '2\n');
    const sub = new SshFsBackend(t.f('proj'), (fn) => fn(t.fake.session), () => undefined, { uploadMaxBytes: 1 });
    const res = await sub.status();
    assert.equal(res.branch, 'main');
    assert.deepEqual(res.changed.map((c) => `${c.code}|${c.path}`).sort(), [' M|a.txt', '??|new file é.txt'].sort());
    const top = await t.backend.status();
    assert.deepEqual(top.changed.map((c) => c.path).sort(), ['outside.txt', 'proj/a.txt', 'proj/new file é.txt']);
  });
  await check('status: rename inside prefix keeps new name; rename out of prefix dropped', async () => {
    const t = setup();
    fs.mkdirSync(t.f('proj'));
    git(t.root, 'init', '-q', '-b', 'main');
    fs.writeFileSync(t.f('proj/old.txt'), 'content content content\n');
    fs.writeFileSync(t.f('proj/mv.txt'), 'other other other other\n');
    git(t.root, 'add', '.');
    git(t.root, 'commit', '-qm', 'init');
    git(t.root, 'mv', 'proj/old.txt', 'proj/new.txt');
    git(t.root, 'mv', 'proj/mv.txt', 'moved.txt');
    const sub = new SshFsBackend(t.f('proj'), (fn) => fn(t.fake.session), () => undefined, { uploadMaxBytes: 1 });
    const res = await sub.status();
    assert.deepEqual(res.changed.map((c) => c.path), ['new.txt']);
  });
  await check('status: git runs with --no-optional-locks (no .git/index refresh), quotepath off', async () => {
    const t = setup();
    git(t.root, 'init', '-q', '-b', 'main');
    fs.writeFileSync(t.f('a.txt'), '1\n');
    git(t.root, 'add', '.');
    git(t.root, 'commit', '-qm', 'init');
    // A newer mtime with unchanged content: a plain `git status` would rewrite the index.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(t.f('a.txt'), later, later);
    const before = fs.statSync(t.f('.git/index')).mtimeMs;
    const res = await t.backend.status();
    assert.deepEqual(res, { branch: 'main', changed: [] });
    assert.equal(fs.statSync(t.f('.git/index')).mtimeMs, before, '.git/index untouched');
    const cd = `cd -- '${t.root}' && `;
    assert.deepEqual(t.fake.calls.execs, [
      `${cd}git --no-optional-locks rev-parse --show-prefix`,
      `${cd}git --no-optional-locks -c core.quotepath=false status --porcelain=v1 --branch`,
    ]);
  });
  await check('status: no repo -> branch null; git missing -> branch null; retryable', async () => {
    const t = setup();
    assert.deepEqual(await t.backend.status(), { branch: null, changed: [] });
    git(t.root, 'init', '-q', '-b', 'main');
    t.fake.switches.probeGit = false;
    assert.deepEqual(await t.backend.status(), { branch: null, changed: [] });
    assert.ok(t.runs.every((o) => o.retryable === true));
  });
  await check('status: denied -> 409', async () => {
    const t = setup();
    const run = async () => { throw new RemoteError('denied', 'nope'); };
    const b = new SshFsBackend(t.root, run, () => undefined, { uploadMaxBytes: 1 });
    await rejectsStatus(() => b.status(), 409, /keine Berechtigung/);
  });

  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall checks passed');
})();
