#!/usr/bin/env node
/*
 * dg ssh scope check (`dg ssh list` / `dg scp`).
 *
 * The route is @Public (dg token instead of a user JWT), RequestContext has
 * no actor, and `SshService.findById()` checks NOTHING without one. The
 * controller's resolution (the project's own connections) is therefore the
 * only boundary — this check pins it:
 *   - foreign connection by id/slug -> 404, no transfer
 *   - connection inherited from a linked customer -> 404 (customer scope
 *     cannot be checked without a user, same rule as `dg kube`)
 *   - workspace no longer belongs to the token's project -> 403
 *   - upload/download pass sourceContext 'dg' + workspaceId through
 *   - scp path rules: `host:` / `host:dir/` keep the file name
 *   - error codes become readable 4xx instead of 500
 *   - audit schema: 'dg' valid without userId, but only with workspaceId
 *
 * Loads from dist/; run `npm run build` first.
 */
const path = require('node:path');
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

const { WorkspaceCliSshController } = loadCompiled('workspaces/workspace-cli-ssh.controller.js');
const { SshAuditSchema } = loadCompiled('ssh/schemas/ssh-audit.schema.js');
const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const EXPECTED_CHECKS = 10;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const statusOf = (e) => (typeof e.getStatus === 'function' ? e.getStatus() : e.status);
const oid = () => new mongoose.Types.ObjectId();
const PROJECT = oid().toString();
const OTHER_PROJECT = oid().toString();
const WORKSPACE = oid().toString();

function conn(slug, { projectId, inheritedFromCustomerId } = {}) {
  return {
    _id: oid(), slug, label: slug, host: `${slug}.example`, port: 22, username: 'deploy',
    projectId: projectId ? new mongoose.Types.ObjectId(projectId) : undefined,
    inheritedFromCustomerId,
    privateKeySecretId: oid(),
  };
}

/**
 * Controller with in-memory fakes. `visible` is what findByProjectId returns
 * for the token's project (own + inherited); everything else exists but must
 * not be reachable.
 */
function setup({ visible, workspaceProject = PROJECT, uploadError, downloadError }) {
  const calls = { uploads: [], downloads: [], writes: [], touched: 0 };
  const ctrl = new WorkspaceCliSshController(
    {
      findById: async () => ({ projectId: new mongoose.Types.ObjectId(workspaceProject) }),
      touch: async () => { calls.touched += 1; },
    },
    {
      readStream: async (_ws, p) => ({ stream: Readable.from([Buffer.from('hello')]), size: 5, path: p }),
      writeStream: async (ws, target, source, opts) => {
        for await (const _chunk of source) { /* drain */ }
        calls.writes.push({ ws, target, opts });
        return { ok: true, path: target.endsWith('/') || target === '.' ? `${target === '.' ? '' : target}${opts.fileName}` : target, size: opts.size };
      },
    },
    { findByProjectId: async (p) => (p === PROJECT ? visible : []) },
    {
      sftpUploadStream: async (connId, remotePath, stream, opts) => {
        if (uploadError) throw new Error(uploadError);
        for await (const _chunk of stream) { /* drain */ }
        calls.uploads.push({ connId, remotePath, opts });
        return { remotePath, bytesWritten: 5 };
      },
      sftpDownloadStream: async (connId, remotePath, sink, opts) => {
        if (downloadError) throw new Error(downloadError);
        calls.downloads.push({ connId, remotePath, opts });
        const sinkResult = await sink(Readable.from([Buffer.from('abc')]), 3);
        return { remotePath, size: 3, sinkResult };
      },
    },
  );
  const req = { workspaceCli: { workspaceId: WORKSPACE, projectId: PROJECT } };
  return { ctrl, req, calls };
}

(async () => {
  const own = conn('prod', { projectId: PROJECT });
  const inherited = conn('kunde', { inheritedFromCustomerId: oid().toString() });
  const inheritedProd = conn('prod', { inheritedFromCustomerId: oid().toString() });
  const foreign = conn('fremd', { projectId: OTHER_PROJECT });

  await check('foreign connection by id and slug -> 404, no transfer', async () => {
    const { ctrl, req, calls } = setup({ visible: [own] });
    await assert.rejects(() => ctrl.upload(req, { connection: foreign._id.toString(), source: 'a.txt', remotePath: '/tmp/' }), (e) => statusOf(e) === 404);
    await assert.rejects(() => ctrl.download(req, { connection: 'fremd', remotePath: '/etc/hosts', target: '.' }), (e) => statusOf(e) === 404);
    assert.deepEqual(calls.uploads, []);
    assert.deepEqual(calls.downloads, []);
  });

  await check('inherited customer connection by slug and id -> 404, no transfer', async () => {
    const { ctrl, req, calls } = setup({ visible: [own, inherited] });
    await assert.rejects(() => ctrl.upload(req, { connection: 'kunde', source: 'a.txt', remotePath: '/srv/a.txt' }), (e) => statusOf(e) === 404);
    await assert.rejects(() => ctrl.download(req, { connection: inherited._id.toString(), remotePath: '/x', target: '.' }), (e) => statusOf(e) === 404);
    assert.deepEqual(calls.uploads, []);
    assert.deepEqual(calls.downloads, []);
  });

  await check('own slug is used even when an inherited one has the same slug', async () => {
    const { ctrl, req, calls } = setup({ visible: [own, inheritedProd] });
    await ctrl.upload(req, { connection: 'prod', source: 'a.txt', remotePath: '/srv/a.txt' });
    assert.equal(calls.uploads[0].connId, own._id.toString());
  });

  await check('only inherited connections with that slug -> 404', async () => {
    const other = conn('prod', { inheritedFromCustomerId: oid().toString() });
    const { ctrl, req, calls } = setup({ visible: [inheritedProd, other] });
    await assert.rejects(() => ctrl.upload(req, { connection: 'prod', source: 'a.txt', remotePath: '/x' }), (e) => statusOf(e) === 404);
    assert.deepEqual(calls.uploads, []);
  });

  await check('workspace does not belong to the token\'s project -> 403', async () => {
    const { ctrl, req, calls } = setup({ visible: [own], workspaceProject: OTHER_PROJECT });
    await assert.rejects(() => ctrl.list(req), (e) => statusOf(e) === 403);
    await assert.rejects(() => ctrl.upload(req, { connection: 'prod', source: 'a', remotePath: '/x' }), (e) => statusOf(e) === 403);
    assert.deepEqual(calls.uploads, []);
  });

  await check('list shows only own connections, without secret references', async () => {
    const { ctrl, req } = setup({ visible: [own, inherited] });
    const rows = await ctrl.list(req);
    assert.deepEqual(rows.map((r) => r.slug), ['prod']);
    assert.ok(!('privateKeySecretId' in rows[0]));
  });

  await check('upload: host: and host:dir/ keep the file name, audited as dg', async () => {
    const { ctrl, req, calls } = setup({ visible: [own] });
    await ctrl.upload(req, { connection: 'prod', source: 'dist/app.tar.gz', remotePath: '' });
    await ctrl.upload(req, { connection: 'prod', source: 'dist/app.tar.gz', remotePath: '/opt/app/' });
    await ctrl.upload(req, { connection: 'prod', source: 'dist/app.tar.gz', remotePath: '/opt/app' });
    assert.deepEqual(calls.uploads.map((u) => u.remotePath), ['app.tar.gz', '/opt/app/app.tar.gz', '/opt/app']);
    for (const u of calls.uploads) {
      assert.equal(u.opts.sourceContext, 'dg');
      assert.equal(u.opts.workspaceId, WORKSPACE);
      assert.equal(u.opts.userId, undefined);
      assert.equal(u.opts.fileNameIfDir, 'app.tar.gz');
    }
  });

  await check('download: target, file name and size reach the sidecar; directory source -> 400', async () => {
    const { ctrl, req, calls } = setup({ visible: [own] });
    const res = await ctrl.download(req, { connection: 'prod', remotePath: '/var/log/app.log', target: '' });
    assert.equal(calls.writes[0].target, '.');
    assert.equal(calls.writes[0].opts.fileName, 'app.log');
    assert.equal(calls.writes[0].opts.size, 3);
    assert.equal(calls.downloads[0].opts.sourceContext, 'dg');
    assert.equal(calls.downloads[0].opts.workspaceId, WORKSPACE);
    assert.equal(res.target, 'app.log');
    assert.equal(calls.touched, 1);
    await assert.rejects(() => ctrl.download(req, { connection: 'prod', remotePath: '/var/log/', target: '.' }), (e) => statusOf(e) === 400);
  });

  await check('error codes become 413 / 404 / 403 instead of 500', async () => {
    let s = setup({ visible: [own], uploadError: 'upload_too_large: 20 > 10' });
    await assert.rejects(() => s.ctrl.upload(s.req, { connection: 'prod', source: 'a', remotePath: '/x' }), (e) => statusOf(e) === 413);
    s = setup({ visible: [own], downloadError: 'remote_not_found: /nope' });
    await assert.rejects(() => s.ctrl.download(s.req, { connection: 'prod', remotePath: '/nope', target: '.' }), (e) => statusOf(e) === 404);
    s = setup({ visible: [own], downloadError: 'tofu_not_accepted' });
    await assert.rejects(() => s.ctrl.download(s.req, { connection: 'prod', remotePath: '/x', target: '.' }), (e) => statusOf(e) === 403);
  });

  await check('audit schema: dg needs workspaceId instead of userId, all others still need userId', () => {
    const Model = mongoose.model('SshAuditCheck', SshAuditSchema);
    const base = { connectionId: oid(), action: 'upload' };
    assert.equal(new Model({ ...base, sourceContext: 'dg', workspaceId: oid() }).validateSync(), undefined);
    assert.ok(new Model({ ...base, sourceContext: 'dg' }).validateSync()?.errors.workspaceId);
    assert.ok(new Model({ ...base, sourceContext: 'mcp' }).validateSync()?.errors.userId);
    assert.equal(new Model({ ...base, sourceContext: 'mcp', userId: oid() }).validateSync(), undefined);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Expected ${EXPECTED_CHECKS} checks, ran ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
