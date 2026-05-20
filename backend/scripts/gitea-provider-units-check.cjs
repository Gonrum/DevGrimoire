#!/usr/bin/env node
/*
 * Pure-logic regression check for GiteaProviderService.
 * Loads compiled artifacts from dist/.
 *
 * Run with `npm run check:gitea-provider` from backend/ after `npm run build`.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { GiteaProviderService } = loadCompiled('commits/providers/gitea-provider.service.js');

let failures = 0;
let total = 0;
function check(label, fn) {
  total += 1;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`✓ ${label}`))
    .catch((err) => {
      failures += 1;
      console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
    });
}

// --- fetch-stub helpers ---
const originalFetch = global.fetch;
function withStubFetch(impl, fn) {
  global.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => { global.fetch = originalFetch; });
}

function mkResponse({ status = 200, ok = true, body = [], headers = {} } = {}) {
  return {
    status,
    ok,
    statusText: ok ? 'OK' : 'ERR',
    json: async () => body,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  };
}

const baseConfig = {
  provider: 'gitea',
  baseUrl: 'https://gitea.example.com',
  owner: 'acme',
  repo: 'widget',
  defaultBranch: 'main',
  allowPrivateHost: false,
  label: '',
  gitlabProjectId: '',
  syncEnabled: true,
};

(async () => {
  const svc = new GiteaProviderService();

  await check('fetchCommits parses sample response', async () => {
    await withStubFetch(
      async () => mkResponse({
        body: [
          {
            sha: 'abc123',
            commit: {
              message: 'feat: stuff',
              author: { name: 'Alice', email: 'a@x', date: '2026-05-01T12:00:00Z' },
            },
            html_url: 'https://gitea.example.com/acme/widget/commit/abc123',
            stats: { additions: 10, deletions: 2 },
            files: [{ filename: 'a.ts' }, { filename: 'b.ts' }],
          },
        ],
      }),
      async () => {
        const result = await svc.fetchCommits(baseConfig, 'tkn');
        assert.equal(result.commits.length, 1);
        assert.equal(result.commits[0].sha, 'abc123');
        assert.equal(result.commits[0].authorName, 'Alice');
        assert.equal(result.commits[0].additions, 10);
        assert.equal(result.commits[0].changedFiles, 2);
      },
    );
  });

  await check('fetchCommits throws on 401', async () => {
    await withStubFetch(
      async () => mkResponse({ status: 401, ok: false, body: {} }),
      async () => {
        await assert.rejects(svc.fetchCommits(baseConfig, 'tkn'), /Gitea auth error/);
      },
    );
  });

  await check('fetchReleases maps tag, url, dates', async () => {
    await withStubFetch(
      async () => mkResponse({
        body: [
          {
            id: 42,
            tag_name: 'v1.2.0',
            name: 'Release 1.2',
            body: 'changes',
            published_at: '2026-04-01T10:00:00Z',
            html_url: 'https://gitea.example.com/acme/widget/releases/tag/v1.2.0',
            draft: false,
            prerelease: false,
            assets: [{ name: 'bin.zip', browser_download_url: 'https://x/bin.zip', type: 'application/zip' }],
          },
        ],
      }),
      async () => {
        const rels = await svc.fetchReleases(baseConfig, 'tkn');
        assert.equal(rels.length, 1);
        assert.equal(rels[0].providerReleaseId, '42');
        assert.equal(rels[0].tagName, 'v1.2.0');
        assert.equal(rels[0].assets.length, 1);
        assert.equal(rels[0].assets[0].name, 'bin.zip');
      },
    );
  });

  await check('fetchBranches marks default', async () => {
    await withStubFetch(
      async () => mkResponse({
        body: [
          { name: 'main' },
          { name: 'feature/x' },
        ],
      }),
      async () => {
        const branches = await svc.fetchBranches(baseConfig, 'tkn');
        assert.equal(branches.length, 2);
        assert.equal(branches.find((b) => b.name === 'main').isDefault, true);
        assert.equal(branches.find((b) => b.name === 'feature/x').isDefault, false);
      },
    );
  });

  await check('validateToken true on 200', async () => {
    await withStubFetch(
      async () => mkResponse({ body: { id: 1 } }),
      async () => {
        assert.equal(await svc.validateToken(baseConfig, 'tkn'), true);
      },
    );
  });

  await check('validateToken false on 401', async () => {
    await withStubFetch(
      async () => mkResponse({ status: 401, ok: false, body: {} }),
      async () => {
        assert.equal(await svc.validateToken(baseConfig, 'tkn'), false);
      },
    );
  });

  await check('allowPrivateHost=true bypasses SSRF validator', async () => {
    const cfg = { ...baseConfig, baseUrl: 'http://127.0.0.1:3000', allowPrivateHost: true };
    await withStubFetch(
      async () => mkResponse({ body: [] }),
      async () => {
        // Sollte nicht werfen, obwohl die URL privat ist.
        const result = await svc.fetchCommits(cfg, 'tkn');
        assert.deepEqual(result.commits, []);
      },
    );
  });

  await check('allowPrivateHost=false blocks loopback', async () => {
    const cfg = { ...baseConfig, baseUrl: 'http://127.0.0.1:3000', allowPrivateHost: false };
    await assert.rejects(svc.fetchCommits(cfg, 'tkn'), /private/);
  });

  console.log(`\n${total - failures}/${total} checks passed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
