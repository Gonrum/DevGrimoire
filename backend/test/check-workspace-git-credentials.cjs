#!/usr/bin/env node
/*
 * T-541: the Git token must not travel inside the clone URL (git stored it as
 * the `origin` URL in the workspace's `.git/config`). The backend resolves
 * credentials separately and sends them to the sidecar as `auth` (clone) or
 * token env (pull); the URL it sends is always the plain one.
 *
 * Runs against dist/ — `npm run build` first.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.resolve(__dirname, '..', 'dist');
const SRC = path.resolve(__dirname, '..', 'src');
const load = (rel) => require(path.join(DIST, rel));

let failures = 0, total = 0;
async function t(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

async function main() {
  const { WorkspaceGitTokensService } = load('workspaces/workspace-git-tokens.service.js');
  const { WorkspaceClient } = load('workspaces/workspace-client.service.js');

  const repos = [
    { _id: 'r-gh', provider: 'github', tokenSecretId: 's-gh' },
    { _id: 'r-gl', provider: 'gitlab', baseUrl: 'https://git.corp.example', tokenSecretId: 's-gl' },
  ];
  const tokens = { 's-gh': 'ghp_TOKEN/with+chars', 's-gl': 'glpat-TOKEN' };
  const projects = { findById: () => Promise.resolve({ gitRepositories: repos }) };
  const secrets = { findValueForOwner: (id) => Promise.resolve(tokens[id] ?? null) };
  const svc = new WorkspaceGitTokensService(projects, secrets);
  const ws = { _id: 'w1', projectId: 'p1', location: 'container' };

  await t('the URL-embedding builder is gone', () => {
    assert.equal(typeof svc.buildAuthenticatedCloneUrl, 'undefined');
  });

  await t('GitHub: x-access-token + raw token, not URL-encoded', async () => {
    assert.deepEqual(await svc.resolveCloneAuth(ws, 'https://github.com/o/r.git'), { username: 'x-access-token', password: 'ghp_TOKEN/with+chars' });
  });

  await t('GitLab (self-hosted host match): oauth2', async () => {
    assert.deepEqual(await svc.resolveCloneAuth(ws, 'https://git.corp.example/g/r.git'), { username: 'oauth2', password: 'glpat-TOKEN' });
  });

  await t('explicit gitRepoId pin wins over host match', async () => {
    assert.deepEqual(await svc.resolveCloneAuth({ ...ws, gitRepoId: 'r-gl' }, 'https://github.com/o/r.git'), { username: 'oauth2', password: 'glpat-TOKEN' });
  });

  await t('URL that already carries userinfo / non-http / garbage: no auth', async () => {
    assert.equal(await svc.resolveCloneAuth(ws, 'https://u:p@github.com/o/r.git'), null);
    assert.equal(await svc.resolveCloneAuth(ws, 'ssh://github.com/o/r.git'), null);
    assert.equal(await svc.resolveCloneAuth(ws, 'not a url'), null);
  });

  await t('no token configured: no auth', async () => {
    const empty = new WorkspaceGitTokensService({ findById: () => Promise.resolve({ gitRepositories: [] }) }, secrets);
    assert.equal(await empty.resolveCloneAuth(ws, 'https://github.com/o/r.git'), null);
  });

  await t('ssh workspace is refused', async () => {
    await assert.rejects(svc.resolveCloneAuth({ ...ws, location: 'ssh' }, 'https://github.com/o/r.git'), (e) => e.getStatus() === 409);
  });

  await t('client: clone sends auth beside the plain URL, pull sends token env', async () => {
    const calls = [];
    const client = Object.create(WorkspaceClient.prototype);
    client.cloneTimeoutMs = 1;
    client.post = (endpoint, body) => { calls.push({ endpoint, body }); return Promise.resolve({ ok: true }); };
    await client.clone('w1', 'https://github.com/o/r.git', 'main', { username: 'x-access-token', password: 'tok' });
    await client.pull('w1', { GH_TOKEN: 'tok' });
    assert.deepEqual(calls[0], { endpoint: '/clone', body: { workspaceId: 'w1', repoUrl: 'https://github.com/o/r.git', branch: 'main', auth: { username: 'x-access-token', password: 'tok' } } });
    assert.deepEqual(calls[1], { endpoint: '/pull', body: { workspaceId: 'w1', env: { GH_TOKEN: 'tok' } } });
  });

  await t('MCP and chat clone/pull pass credentials, never a token URL', () => {
    for (const rel of ['mcp-tools.ts', 'chat/chat-tools.ts']) {
      const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
      assert.ok(!src.includes('buildAuthenticatedCloneUrl'), `${rel} still builds a token URL`);
      assert.match(src, /resolveCloneAuth\(/, `${rel} does not resolve clone auth`);
      assert.ok(/orkspaceClient\.pull\(\w+\._id\.toString\(\), gitEnv\)/.test(src), `${rel} pull without token env`);
    }
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (failures) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
