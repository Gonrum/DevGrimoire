#!/usr/bin/env node
/*
 * Verhaltens-Check für die drei Git-Provider (M-52 / T-450).
 *
 * Deckt vor allem die Skip-Pfade ab, die beim Typisieren entstanden sind: fehlt
 * einem Datensatz ein Feld, das das Schema als `required` führt, wird er
 * übersprungen statt einen Sync-Abbruch oder — schlimmer — einen Filter-Treffer
 * auf einem fremden Commit zu erzeugen. Dazu Objekt-Bodies mit HTTP 200,
 * ETag/304 und die Asset-Filterung.
 *
 * `fetch` wird gestubbt, es geht kein Netzwerkverkehr raus.
 * Lädt aus dist/ — vorher bauen. Läuft über `npm run check:git-providers`.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

const DIST = path.resolve(__dirname, '..', 'dist', 'commits', 'providers');
const { GiteaProviderService } = require(path.join(DIST, 'gitea-provider.service.js'));
const { GitHubProviderService } = require(path.join(DIST, 'github-provider.service.js'));
const { GitLabProviderService } = require(path.join(DIST, 'gitlab-provider.service.js'));

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

const originalFetch = global.fetch;
function withStubFetch(impl, fn) {
  global.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = originalFetch; });
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

const giteaConfig = {
  provider: 'gitea', baseUrl: 'https://gitea.example.com', owner: 'acme', repo: 'widget',
  defaultBranch: 'main', allowPrivateHost: false, label: '', gitlabProjectId: '', syncEnabled: true,
};
const ghConfig = { ...giteaConfig, provider: 'github', baseUrl: '' };
const glConfig = { ...giteaConfig, provider: 'gitlab', baseUrl: '' };

(async () => {
  const gitea = new GiteaProviderService();
  const github = new GitHubProviderService();
  const gitlab = new GitLabProviderService();

  // ---------------- existing gitea-provider-units-check.cjs cases ----------------
  await check('[gitea] fetchCommits parses sample response', async () => {
    await withStubFetch(async () => mkResponse({ body: [{
      sha: 'abc123',
      commit: { message: 'feat: stuff', author: { name: 'Alice', email: 'a@x', date: '2026-05-01T12:00:00Z' } },
      html_url: 'https://gitea.example.com/acme/widget/commit/abc123',
      stats: { additions: 10, deletions: 2 },
      files: [{ filename: 'a.ts' }, { filename: 'b.ts' }],
    }] }), async () => {
      const r = await gitea.fetchCommits(giteaConfig, 'tkn');
      assert.equal(r.commits.length, 1);
      assert.equal(r.commits[0].sha, 'abc123');
      assert.equal(r.commits[0].authorName, 'Alice');
      assert.equal(r.commits[0].additions, 10);
      assert.equal(r.commits[0].changedFiles, 2);
      assert.equal(r.commits[0].committedAt.toISOString(), '2026-05-01T12:00:00.000Z');
    });
  });

  await check('[gitea] fetchCommits throws on 401', async () => {
    await withStubFetch(async () => mkResponse({ status: 401, ok: false, body: {} }), async () => {
      await assert.rejects(gitea.fetchCommits(giteaConfig, 'tkn'), /Gitea auth error/);
    });
  });

  await check('[gitea] fetchReleases maps tag, url, dates', async () => {
    await withStubFetch(async () => mkResponse({ body: [{
      id: 42, tag_name: 'v1.2.0', name: 'Release 1.2', body: 'changes',
      published_at: '2026-04-01T10:00:00Z',
      html_url: 'https://gitea.example.com/acme/widget/releases/tag/v1.2.0',
      draft: false, prerelease: false,
      assets: [{ name: 'bin.zip', browser_download_url: 'https://x/bin.zip', type: 'application/zip' }],
    }] }), async () => {
      const rels = await gitea.fetchReleases(giteaConfig, 'tkn');
      assert.equal(rels.length, 1);
      assert.equal(rels[0].providerReleaseId, '42');
      assert.equal(rels[0].tagName, 'v1.2.0');
      assert.equal(rels[0].assets.length, 1);
      assert.equal(rels[0].assets[0].name, 'bin.zip');
      assert.equal(rels[0].assets[0].format, 'application/zip');
      assert.equal(rels[0].releasedAt.toISOString(), '2026-04-01T10:00:00.000Z');
    });
  });

  await check('[gitea] fetchBranches marks default', async () => {
    await withStubFetch(async () => mkResponse({ body: [{ name: 'main' }, { name: 'feature/x' }] }), async () => {
      const branches = await gitea.fetchBranches(giteaConfig, 'tkn');
      assert.equal(branches.length, 2);
      assert.equal(branches.find((b) => b.name === 'main').isDefault, true);
      assert.equal(branches.find((b) => b.name === 'feature/x').isDefault, false);
    });
  });

  await check('[gitea] validateToken true on 200 / false on 401', async () => {
    await withStubFetch(async () => mkResponse({ body: { id: 1 } }), async () => {
      assert.equal(await gitea.validateToken(giteaConfig, 'tkn'), true);
    });
    await withStubFetch(async () => mkResponse({ status: 401, ok: false, body: {} }), async () => {
      assert.equal(await gitea.validateToken(giteaConfig, 'tkn'), false);
    });
  });

  await check('[gitea] allowPrivateHost=true bypasses SSRF validator', async () => {
    const cfg = { ...giteaConfig, baseUrl: 'http://127.0.0.1:3000', allowPrivateHost: true };
    await withStubFetch(async () => mkResponse({ body: [] }), async () => {
      const r = await gitea.fetchCommits(cfg, 'tkn');
      assert.deepEqual(r.commits, []);
    });
  });

  await check('[gitea] allowPrivateHost=false blocks loopback', async () => {
    const cfg = { ...giteaConfig, baseUrl: 'http://127.0.0.1:3000', allowPrivateHost: false };
    await assert.rejects(gitea.fetchCommits(cfg, 'tkn'), /private/);
  });

  // ---------------- new: sparse / hostile payloads ----------------
  await check('[gitea] commit without sha is skipped, others survive', async () => {
    await withStubFetch(async () => mkResponse({ body: [
      { commit: { message: 'no sha', author: { date: '2026-05-01T12:00:00Z' } } },
      { sha: 'ok1', created: '2026-05-02T12:00:00Z' },
    ] }), async () => {
      const r = await gitea.fetchCommits(giteaConfig, 'tkn');
      assert.equal(r.commits.length, 1);
      assert.equal(r.commits[0].sha, 'ok1');
      assert.equal(r.commits[0].authorName, 'Unknown');
      assert.equal(r.commits[0].message, '');
      assert.equal(r.commits[0].url, 'https://gitea.example.com/acme/widget/commit/ok1');
      assert.equal(r.commits[0].committedAt.toISOString(), '2026-05-02T12:00:00.000Z');
    });
  });

  await check('[gitea] minimal release (no assets/name/id/dates) still maps', async () => {
    await withStubFetch(async () => mkResponse({ body: [{ tag_name: 'v9' }] }), async () => {
      const rels = await gitea.fetchReleases(giteaConfig, 'tkn');
      assert.equal(rels.length, 1);
      assert.equal(rels[0].providerReleaseId, 'v9');
      assert.equal(rels[0].name, 'v9');
      assert.deepEqual(rels[0].assets, []);
      assert.equal(rels[0].url, 'https://gitea.example.com/acme/widget/releases/tag/v9');
      assert.equal(rels[0].releasedAt.getTime(), 0);
    });
  });

  await check('[gitea] object body on branches throws a clear error', async () => {
    await withStubFetch(async () => mkResponse({ body: { message: 'token required' } }), async () => {
      await assert.rejects(gitea.fetchBranches(giteaConfig, 'tkn'), /not an array/);
    });
  });

  await check('[gitea] object body on commits ends pagination without throwing', async () => {
    await withStubFetch(async () => mkResponse({ body: { message: 'nope' } }), async () => {
      const r = await gitea.fetchCommits(giteaConfig, 'tkn');
      assert.deepEqual(r.commits, []);
    });
  });

  // ---------------- github ----------------
  await check('[github] fetchCommits parses + falls back to committer date', async () => {
    await withStubFetch(async () => mkResponse({ body: [
      { sha: 'gh1', commit: { message: 'm', author: null, committer: { date: '2026-01-02T03:04:05Z' } }, author: { login: 'octo' }, html_url: 'https://gh/c/gh1' },
    ], headers: { etag: 'W/"tag"' } }), async () => {
      const r = await github.fetchCommits(ghConfig, 'tkn');
      assert.equal(r.commits.length, 1);
      assert.equal(r.commits[0].authorName, 'octo');
      assert.equal(r.commits[0].committedAt.toISOString(), '2026-01-02T03:04:05.000Z');
      assert.equal(r.etag, 'W/"tag"');
    });
  });

  await check('[github] 304 short-circuits to notModified', async () => {
    await withStubFetch(async () => mkResponse({ status: 304, ok: false, body: {} }), async () => {
      const r = await github.fetchCommits(ghConfig, 'tkn', undefined, 'etag-1');
      assert.equal(r.notModified, true);
      assert.equal(r.etag, 'etag-1');
    });
  });

  await check('[github] fetchCommitStats reads stats + file count', async () => {
    await withStubFetch(async () => mkResponse({ body: { stats: { additions: 5, deletions: 1 }, files: [1, 2, 3] } }), async () => {
      assert.deepEqual(await github.fetchCommitStats(ghConfig, 'tkn', 'sha'), { additions: 5, deletions: 1, changedFiles: 3 });
    });
  });

  await check('[github] fetchBranches maps protected flag', async () => {
    await withStubFetch(async () => mkResponse({ body: [{ name: 'main', protected: true }, { name: 'x' }, {}] }), async () => {
      const b = await github.fetchBranches(ghConfig, 'tkn');
      assert.equal(b.length, 2, 'nameless entry dropped');
      assert.equal(b[0].isDefault, true);
      assert.equal(b[1].isDefault, false);
    });
  });

  await check('[github] fetchReleases maps assets and nullable name/body', async () => {
    await withStubFetch(async () => mkResponse({ body: [
      { id: 7, tag_name: 'v2', name: null, body: null, published_at: null, created_at: '2026-02-02T00:00:00Z', html_url: 'https://gh/r/v2', draft: true, prerelease: false,
        assets: [{ name: 'a.tgz', browser_download_url: 'https://gh/a.tgz', content_type: 'application/gzip' }, { name: 'broken' }] },
    ] }), async () => {
      const rels = await github.fetchReleases(ghConfig, 'tkn');
      assert.equal(rels.length, 1);
      assert.equal(rels[0].name, 'v2');
      assert.equal(rels[0].description, '');
      assert.equal(rels[0].draft, true);
      assert.equal(rels[0].releasedAt.toISOString(), '2026-02-02T00:00:00.000Z');
      assert.equal(rels[0].assets.length, 1, 'asset without url dropped');
      assert.equal(rels[0].assets[0].format, 'application/gzip');
    });
  });

  // ---------------- gitlab ----------------
  await check('[gitlab] fetchCommits maps id/authored_date/stats', async () => {
    await withStubFetch(async () => mkResponse({ body: [
      { id: 'gl1', message: 'msg', author_name: 'Bob', author_email: 'b@x', authored_date: '2026-03-03T00:00:00Z', web_url: 'https://gl/c/gl1', stats: { additions: 3, deletions: 4 } },
      { message: 'no id', created_at: '2026-03-03T00:00:00Z' },
    ] }), async () => {
      const r = await gitlab.fetchCommits(glConfig, 'tkn');
      assert.equal(r.commits.length, 1);
      assert.equal(r.commits[0].sha, 'gl1');
      assert.equal(r.commits[0].additions, 3);
      assert.equal(r.commits[0].committedAt.toISOString(), '2026-03-03T00:00:00.000Z');
    });
  });

  await check('[gitlab] fetchCommitStats combines diff count + stats', async () => {
    let call = 0;
    await withStubFetch(async () => {
      call += 1;
      return call === 1
        ? mkResponse({ body: [{ new_path: 'a' }, { new_path: 'b' }] })
        : mkResponse({ body: { stats: { additions: 8, deletions: 2 } } });
    }, async () => {
      assert.deepEqual(await gitlab.fetchCommitStats(glConfig, 'tkn', 'sha'), { additions: 8, deletions: 2, changedFiles: 2 });
    });
  });

  await check('[gitlab] fetchCommitStats survives non-array diff body', async () => {
    let call = 0;
    await withStubFetch(async () => {
      call += 1;
      return call === 1
        ? mkResponse({ body: { message: '404' } })
        : mkResponse({ body: { stats: { additions: 1, deletions: 0 } } });
    }, async () => {
      assert.deepEqual(await gitlab.fetchCommitStats(glConfig, 'tkn', 'sha'), { additions: 1, deletions: 0, changedFiles: undefined });
    });
  });

  await check('[gitlab] fetchBranches maps default flag', async () => {
    await withStubFetch(async () => mkResponse({ body: [{ name: 'main', default: true }, { name: 'x', default: false }] }), async () => {
      const b = await gitlab.fetchBranches(glConfig, 'tkn');
      assert.equal(b[0].isDefault, true);
      assert.equal(b[1].isDefault, false);
    });
  });

  await check('[gitlab] fetchReleases maps links, sources and _links.self', async () => {
    await withStubFetch(async () => mkResponse({ body: [
      { tag_name: 'v3', name: 'Three', description: 'd', released_at: '2026-04-04T00:00:00Z',
        assets: {
          links: [
            { name: 'runbook', url: 'https://gl/u', direct_asset_url: 'https://gl/direct', link_type: 'runbook' },
            { name: 'legacy', url: 'https://gl/legacy' },
            { url: 'https://gl/nameless' },
          ],
          sources: [{ format: 'zip', url: 'https://gl/z.zip' }, { url: 'https://gl/no-format' }],
        },
        _links: { self: 'https://gl/r/v3' } },
      { name: 'no tag' },
    ] }), async () => {
      const rels = await gitlab.fetchReleases(glConfig, 'tkn');
      assert.equal(rels.length, 1, 'release without tag_name skipped');
      assert.equal(rels[0].providerReleaseId, 'v3');
      assert.equal(rels[0].url, 'https://gl/r/v3');
      assert.deepEqual(rels[0].assets, [
        { name: 'runbook', url: 'https://gl/direct', format: 'runbook' },
        { name: 'legacy', url: 'https://gl/legacy', format: undefined },
        { name: 'source.zip', url: 'https://gl/z.zip', format: 'zip' },
      ]);
    });
  });

  await check('[gitlab] release without assets block and without _links falls back', async () => {
    await withStubFetch(async () => mkResponse({ body: [{ tag_name: 'v4', created_at: '2026-05-05T00:00:00Z' }] }), async () => {
      const rels = await gitlab.fetchReleases({ ...glConfig, baseUrl: 'https://gl.example' }, 'tkn');
      assert.deepEqual(rels[0].assets, []);
      assert.equal(rels[0].url, 'https://gl.example/-/releases/v4');
      assert.equal(rels[0].name, 'v4');
      assert.equal(rels[0].releasedAt.toISOString(), '2026-05-05T00:00:00.000Z');
    });
  });

  console.log(`\n${total - failures}/${total} checks passed.`);
  process.exit(failures === 0 ? 0 : 1);
})();
