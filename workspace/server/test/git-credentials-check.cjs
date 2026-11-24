#!/usr/bin/env node
/*
 * Sidecar git-credentials check (T-541): the Git token must never end up in
 * a workspace's `.git/config`, and must never be echoed in a response.
 *
 * Runs a real smart-HTTP git server (`git http-backend` behind a tiny Node
 * CGI bridge with Basic auth) so clone/pull really authenticate — no stubbed
 * git. Spawns `node index.js` against a temporary workspace root.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const TOKEN = 'test-token-0123456789';
const GIT_USER = 'x-access-token';
const GIT_TOKEN = 'ghp_SECRETtoken42';
const HELPER = path.join(__dirname, '..', 'git-credential-dg.sh');

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

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
// Async run: the git HTTP server lives in this process, so anything that
// talks to it must not block the event loop (spawnSync would deadlock).
function run(cmd, args, env) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stderr }));
  });
}

/** Smart-HTTP git server: Basic auth required, CGI to `git http-backend`. */
function startGitServer(projectRoot, port) {
  const seen = { authorized: 0, rejected: 0 };
  const server = http.createServer((req, res) => {
    // Like a GitLab/Gitea PAT: any username, the token is what counts.
    const basic = /^Basic (.+)$/.exec(req.headers.authorization || '');
    const pass = basic ? Buffer.from(basic[1], 'base64').toString('utf8').split(':').slice(1).join(':') : '';
    if (pass !== GIT_TOKEN) {
      seen.rejected += 1;
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
      return res.end('auth required');
    }
    seen.authorized += 1;
    const url = new URL(req.url, 'http://x');
    const child = spawn('git', ['http-backend'], {
      env: {
        ...gitEnv,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers['content-type'] || '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '',
        GIT_PROTOCOL: req.headers['git-protocol'] || '',
        REMOTE_USER: GIT_USER,
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    req.pipe(child.stdin);
    let buf = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on('data', (chunk) => {
      if (headersDone) return res.write(chunk);
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return undefined;
      headersDone = true;
      let status = 200;
      const headers = {};
      for (const line of buf.subarray(0, idx).toString('utf8').split('\r\n')) {
        const sep = line.indexOf(':');
        const k = line.slice(0, sep).trim();
        const v = line.slice(sep + 1).trim();
        if (k.toLowerCase() === 'status') status = parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      return res.write(buf.subarray(idx + 4));
    });
    child.on('close', () => res.end());
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, seen })));
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-cred-check-'));
  const root = path.join(tmp, 'root');
  const repos = path.join(tmp, 'repos');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(root);
  fs.mkdirSync(repos);

  // Bare upstream with one commit, written through a separate seed clone.
  git(tmp, 'init', '--bare', '-b', 'main', path.join(repos, 'repo.git'));
  git(tmp, 'init', '-b', 'main', seed);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'one');
  git(seed, 'push', path.join(repos, 'repo.git'), 'main');

  const gitPort = await freePort();
  const gitHost = `127.0.0.1:${gitPort}`;
  const cleanUrl = `http://${gitHost}/repo.git`;
  const tokenUrl = `http://${GIT_USER}:${GIT_TOKEN}@${gitHost}/repo.git`;
  const { server: gitServer, seen } = await startGitServer(repos, gitPort);

  // Recorder for the review's PoC vectors: whatever git runs through it
  // appends its environment to leaks/<name> and then does its real job.
  const leakDir = path.join(tmp, 'leaks');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(leakDir);
  fs.mkdirSync(home);
  const leak = path.join(tmp, 'leak.sh');
  fs.writeFileSync(leak, `#!/bin/sh\nn="$1"; shift\nenv >> '${leakDir}'/"$n"\n[ $# -gt 0 ] && exec "$@"\nexit 0\n`, { mode: 0o755 });
  const leaked = () => fs.readdirSync(leakDir).filter((f) => fs.readFileSync(path.join(leakDir, f), 'utf8').includes(GIT_TOKEN));
  const ran = (name) => fs.existsSync(path.join(leakDir, name));

  // A proxy that only records what reaches it.
  const proxySeen = [];
  const proxy = http.createServer((req, res) => {
    proxySeen.push(`${req.method} ${req.url} ${req.headers.authorization || ''} ${req.headers['proxy-authorization'] || ''}`);
    res.writeHead(502);
    res.end();
  });
  const proxyPort = await freePort();
  await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r));

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: {
      ...process.env, WORKSPACE_ROOT: root, WORKSPACE_API_TOKEN: TOKEN, PORT: String(port),
      HOME: home, DG_GIT_ALLOW_HTTP: '1',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const cleanup = () => {
    child.kill('SIGKILL');
    gitServer.close();
    proxy.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  const addUpstreamCommit = (file, text) => {
    fs.writeFileSync(path.join(seed, file), text);
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', file);
    git(seed, 'push', path.join(repos, 'repo.git'), 'main');
  };
  const configOf = (ws) => fs.readFileSync(path.join(root, ws, '.git', 'config'), 'utf8');
  const originOf = (ws) => git(path.join(root, ws), 'config', '--get', 'remote.origin.url').trim();
  const auth = { username: GIT_USER, password: GIT_TOKEN };
  const pullAuth = { ...auth, host: gitHost };
  // ~/.gitconfig of the workspace user is writable from the terminal.
  const plantedHome = [
    `[filter "x"]\n\tsmudge = '${leak}' home-smudge cat\n`,
    `[core]\n\taskPass = '${leak}' home-askpass\n`,
    `[credential]\n\thelper = !'${leak}' home-credhelper\n`,
    `[http]\n\tproxy = http://127.0.0.1:${proxyPort}\n`,
    `[url "ext::sh -c '${leak} home-ext' "]\n\tinsteadOf = http://${gitHost}/\n`,
  ].join('');

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
      const text = await res.text();
      return { status: res.status, text, body: JSON.parse(text) };
    };

    await check('server sanity: anonymous clone is rejected', async () => {
      const r = await run('git', ['clone', cleanUrl, path.join(tmp, 'anon')], { ...gitEnv, GIT_TERMINAL_PROMPT: '0' });
      assert.notEqual(r.status, 0);
    });

    await check('clone with auth: works, .git/config holds no token and no userinfo', async () => {
      const r = await post('/clone', { workspaceId: 'ws1', repoUrl: cleanUrl, auth });
      assert.equal(r.status, 200, r.text);
      assert.ok(fs.existsSync(path.join(root, 'ws1', 'a.txt')), 'worktree not checked out');
      assert.ok(!configOf('ws1').includes(GIT_TOKEN), 'token in .git/config');
      assert.ok(!configOf('ws1').includes('@'), 'userinfo in .git/config');
      assert.equal(originOf('ws1'), cleanUrl);
      assert.ok(!r.text.includes(GIT_TOKEN), 'token in response');
    });

    await check('clone with userinfo in repoUrl: credentials used, then stripped from the remote', async () => {
      const r = await post('/clone', { workspaceId: 'ws2', repoUrl: tokenUrl });
      assert.equal(r.status, 200, r.text);
      assert.ok(!configOf('ws2').includes(GIT_TOKEN), 'token in .git/config');
      assert.equal(originOf('ws2'), cleanUrl);
      assert.ok(!r.text.includes(GIT_TOKEN), 'token in response');
    });

    await check('/origin returns the credential-free origin URL', async () => {
      const r = await post('/origin', { workspaceId: 'ws1' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.url, cleanUrl);
    });

    await check('pull with host-bound auth: authenticates (shallow clone), config stays clean', async () => {
      addUpstreamCommit('b.txt', 'two\n');
      const r = await post('/pull', { workspaceId: 'ws1', auth: pullAuth });
      assert.equal(r.status, 200, r.text);
      assert.equal(fs.readFileSync(path.join(root, 'ws1', 'b.txt'), 'utf8'), 'two\n');
      assert.ok(!configOf('ws1').includes(GIT_TOKEN));
      assert.ok(!r.text.includes(GIT_TOKEN), 'token in response');
      assert.equal(git(path.join(root, 'ws1'), 'rev-parse', 'origin/main'), git(path.join(root, 'ws1'), 'rev-parse', 'HEAD'));
      assert.equal(git(path.join(root, 'ws1'), 'status', '--porcelain'), '');
    });

    await check('pull with auth for another host: credential not sent, pull fails', async () => {
      const before = seen.authorized;
      const r = await post('/pull', { workspaceId: 'ws1', auth: { ...auth, host: 'other.example' } });
      assert.equal(r.status, 500, r.text);
      assert.equal(seen.authorized, before, 'token reached the git server');
      assert.ok(!r.text.includes(GIT_TOKEN));
    });

    await check('pull rejects auth without host', async () => {
      const r = await post('/pull', { workspaceId: 'ws1', auth });
      assert.equal(r.status, 400, r.text);
    });

    await check('pull without credentials on a clean remote fails, without echoing anything secret', async () => {
      addUpstreamCommit('c.txt', 'three\n');
      const r = await post('/pull', { workspaceId: 'ws2' });
      assert.equal(r.status, 500, r.text);
      assert.ok(!r.text.includes(GIT_TOKEN));
    });

    await check('legacy workspace: token URL in origin is cleaned on pull, pull still authenticates', async () => {
      git(path.join(root, 'ws2'), 'remote', 'set-url', 'origin', tokenUrl);
      git(path.join(root, 'ws2'), 'remote', 'set-url', '--push', 'origin', tokenUrl);
      const r = await post('/pull', { workspaceId: 'ws2' });
      assert.equal(r.status, 200, r.text);
      assert.equal(fs.readFileSync(path.join(root, 'ws2', 'c.txt'), 'utf8'), 'three\n');
      assert.ok(!configOf('ws2').includes(GIT_TOKEN), 'token still in .git/config');
      assert.equal(originOf('ws2'), cleanUrl);
      assert.ok(!r.text.includes(GIT_TOKEN), 'token in response');
    });

    await check('legacy workspace: /status also cleans embedded tokens (remote names with spaces too)', async () => {
      const ws2 = path.join(root, 'ws2');
      git(ws2, 'remote', 'set-url', 'origin', tokenUrl);
      git(ws2, 'remote', 'add', 'other', `https://oauth2:${GIT_TOKEN}@gitlab.example.invalid/g/r.git`);
      git(ws2, 'config', 'remote.my remote.url', `https://oauth2:${GIT_TOKEN}@gitlab.example.invalid/g/s.git`);
      const r = await post('/status', { workspaceId: 'ws2' });
      assert.equal(r.status, 200, r.text);
      assert.ok(!configOf('ws2').includes(GIT_TOKEN), 'token still in .git/config');
      assert.equal(originOf('ws2'), cleanUrl);
      assert.equal(git(ws2, 'config', '--get', 'remote.other.url').trim(), 'https://gitlab.example.invalid/g/r.git');
      assert.equal(git(ws2, 'config', '--get', 'remote.my remote.url').trim(), 'https://gitlab.example.invalid/g/s.git');
    });

    await check('PoC /pull: planted local + ~/.gitconfig never run next to the token', async () => {
      const ws1 = path.join(root, 'ws1');
      git(ws1, 'config', 'filter.x.smudge', `'${leak}' pull-smudge cat`);
      fs.writeFileSync(path.join(ws1, '.git', 'info', 'attributes'), '* filter=x\n');
      git(ws1, 'config', 'remote.origin.uploadpack', `'${leak}' pull-uploadpack git-upload-pack`);
      git(ws1, 'config', 'core.askPass', `'${leak}' pull-askpass`);
      git(ws1, 'config', 'core.sshCommand', `'${leak}' pull-ssh`);
      git(ws1, 'config', `credential.http://${gitHost}.helper`, `!'${leak}' pull-credhelper`);
      git(ws1, 'config', `http.http://${gitHost}/.proxy`, `http://127.0.0.1:${proxyPort}`);
      git(ws1, 'config', `url.ext::sh -c '${leak} pull-ext' .insteadOf`, `http://${gitHost}/`);
      fs.writeFileSync(path.join(home, '.gitconfig'), plantedHome.replace(/home-/g, 'pullhome-'));
      addUpstreamCommit('d.txt', 'four\n');
      const r = await post('/pull', { workspaceId: 'ws1', auth: pullAuth });
      fs.rmSync(path.join(home, '.gitconfig'));
      assert.equal(r.status, 200, r.text);
      assert.equal(fs.readFileSync(path.join(root, 'ws1', 'd.txt'), 'utf8'), 'four\n');
      assert.ok(ran('pull-smudge'), 'smudge filter did not run at all (vector not exercised)');
      assert.deepEqual(leaked(), [], 'token reached a planted command');
      assert.ok(!proxySeen.some((l) => l.includes(Buffer.from(`${GIT_USER}:${GIT_TOKEN}`).toString('base64'))), 'token reached the proxy');
    });

    await check('PoC /clone: planted ~/.gitconfig + committed .gitattributes never see the token', async () => {
      fs.writeFileSync(path.join(seed, '.gitattributes'), '* filter=x\n');
      addUpstreamCommit('e.txt', 'five\n');
      fs.writeFileSync(path.join(home, '.gitconfig'), plantedHome.replace(/home-/g, 'clonehome-'));
      const r = await post('/clone', { workspaceId: 'ws6', repoUrl: cleanUrl, auth });
      fs.rmSync(path.join(home, '.gitconfig'));
      assert.equal(r.status, 200, r.text);
      assert.equal(fs.readFileSync(path.join(root, 'ws6', 'e.txt'), 'utf8'), 'five\n');
      assert.ok(ran('clonehome-smudge'), 'smudge filter did not run at checkout (vector not exercised)');
      assert.deepEqual(leaked(), [], 'token reached a planted command');
      assert.ok(!proxySeen.some((l) => l.includes(Buffer.from(`${GIT_USER}:${GIT_TOKEN}`).toString('base64'))), 'token reached the proxy');
    });

    await check('failed clone with wrong token: no secret in the error response', async () => {
      const wrong = 'glpat-WRONGsecret99';
      const r = await post('/clone', { workspaceId: 'ws3', repoUrl: `http://oauth2:${wrong}@${gitHost}/repo.git` });
      assert.equal(r.status, 500, r.text);
      assert.ok(!r.text.includes(wrong), 'wrong token echoed');
      const r2 = await post('/clone', { workspaceId: 'ws4', repoUrl: cleanUrl, auth: { username: 'oauth2', password: wrong } });
      assert.equal(r2.status, 500, r2.text);
      assert.ok(!r2.text.includes(wrong), 'wrong token echoed');
    });

    await check('clone rejects malformed auth', async () => {
      const r = await post('/clone', { workspaceId: 'ws5', repoUrl: cleanUrl, auth: { username: 'a\nb', password: 'x' } });
      assert.equal(r.status, 400, r.text);
    });

    await check('terminal path: git with the credential helper + GITEA_* env authenticates (no token on disk)', async () => {
      const dest = path.join(tmp, 'term-clone');
      const r = await run('git', ['-c', `credential.helper=!'${HELPER}'`, 'clone', cleanUrl, dest], {
        ...gitEnv, GIT_TERMINAL_PROMPT: '0', GITEA_TOKEN: GIT_TOKEN, GITEA_HOST: gitHost, DG_GIT_ALLOW_HTTP: '1',
      });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!fs.readFileSync(path.join(dest, '.git', 'config'), 'utf8').includes(GIT_TOKEN));
    });

    const helper = (input, env) => spawnSync('sh', [HELPER, 'get'], { input, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).stdout;
    await check('helper: GitHub / GitLab / Gitea host mapping, https only', async () => {
      assert.equal(helper('protocol=https\nhost=github.com\n\n', { GH_TOKEN: 'g1' }), 'username=x-access-token\npassword=g1\n');
      assert.equal(helper('protocol=https\nhost=gitlab.com\n\n', { GITLAB_TOKEN: 'l1' }), 'username=oauth2\npassword=l1\n');
      assert.equal(helper('protocol=https\nhost=git.corp.example\n\n', { GITLAB_TOKEN: 'l1', GITLAB_HOST: 'git.corp.example' }), 'username=oauth2\npassword=l1\n');
      assert.equal(helper('protocol=https\nhost=gitlab.com\n\n', { GITLAB_TOKEN: 'l1', GITLAB_HOST: 'git.corp.example' }), '');
      assert.equal(helper('protocol=https\nhost=tea.example\n\n', { GITEA_TOKEN: 't1', GITEA_HOST: 'tea.example' }), 'username=oauth2\npassword=t1\n');
      // A token never goes to a host it was not issued for.
      assert.equal(helper('protocol=https\nhost=evil.example\n\n', { GH_TOKEN: 'g1', GITLAB_TOKEN: 'l1' }), '');
      // Explicit one-shot credentials are bound to their host.
      assert.equal(helper('protocol=https\nhost=a.example\n\n', { DG_GIT_HOST: 'a.example', DG_GIT_USERNAME: 'u', DG_GIT_PASSWORD: 'p' }), 'username=u\npassword=p\n');
      assert.equal(helper('protocol=https\nhost=b.example\n\n', { DG_GIT_HOST: 'a.example', DG_GIT_USERNAME: 'u', DG_GIT_PASSWORD: 'p' }), '');
      // Plain http only with the test flag; anything else never.
      assert.equal(helper('protocol=http\nhost=github.com\n\n', { GH_TOKEN: 'g1' }), '');
      assert.equal(helper('protocol=http\nhost=github.com\n\n', { GH_TOKEN: 'g1', DG_GIT_ALLOW_HTTP: '1' }), 'username=x-access-token\npassword=g1\n');
      assert.equal(helper('host=github.com\n\n', { GH_TOKEN: 'g1' }), '');
      assert.equal(helper('protocol=ssh\nhost=github.com\n\n', { GH_TOKEN: 'g1', DG_GIT_ALLOW_HTTP: '1' }), '');
      // Only `get` answers; store/erase are no-ops.
      assert.equal(spawnSync('sh', [HELPER, 'store'], { input: 'protocol=https\nhost=github.com\n\n', env: { GH_TOKEN: 'g1' }, encoding: 'utf8' }).stdout, '');
    });

    assert.ok(seen.authorized > 0 && seen.rejected > 0, 'git server saw no authenticated traffic');
  } finally {
    cleanup();
  }
  console.log(`\n${total - failures}/${total} passed`);
  if (failures) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
