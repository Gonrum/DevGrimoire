#!/usr/bin/env node
/*
 * dg-ssh-Scope-Check (`dg ssh list` / `dg scp`).
 *
 * Die Route ist @Public (dg-Token statt Nutzer-JWT), RequestContext hat
 * keinen Actor, und `SshService.findById()` prüft ohne Actor NICHTS. Die
 * Auflösung im Controller (Projekt + verlinkte Kunden) ist damit die einzige
 * Grenze — dieser Check hält sie fest:
 *   - fremde Verbindung per Id/Slug -> 404, kein Transfer
 *   - geerbte Kundenverbindung -> erlaubt; eigener Slug schlägt geerbten
 *   - gleicher Slug bei mehreren geerbten -> 400 mit Ids
 *   - Workspace gehört nicht (mehr) zum Projekt des Tokens -> 403
 *   - Upload/Download reichen sourceContext 'dg' + workspaceId durch
 *   - scp-Pfadregeln: `host:` / `host:dir/` behalten den Dateinamen
 *   - Fehlercodes werden zu lesbaren 4xx statt 500
 *   - Audit-Schema: 'dg' ohne userId gültig, aber nur mit workspaceId
 *
 * Lädt aus dist/; vorher `npm run build`.
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
 * Controller mit In-Memory-Fakes. `visible` ist, was findByProjectId für das
 * Projekt des Tokens liefert (eigene + geerbte); alles andere existiert zwar,
 * darf aber nicht erreichbar sein.
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

  await check('fremde Verbindung per Id und Slug -> 404, kein Transfer', async () => {
    const { ctrl, req, calls } = setup({ visible: [own] });
    await assert.rejects(() => ctrl.upload(req, { connection: foreign._id.toString(), source: 'a.txt', remotePath: '/tmp/' }), (e) => statusOf(e) === 404);
    await assert.rejects(() => ctrl.download(req, { connection: 'fremd', remotePath: '/etc/hosts', target: '.' }), (e) => statusOf(e) === 404);
    assert.deepEqual(calls.uploads, []);
    assert.deepEqual(calls.downloads, []);
  });

  await check('geerbte Kundenverbindung per Slug -> erlaubt', async () => {
    const { ctrl, req, calls } = setup({ visible: [own, inherited] });
    await ctrl.upload(req, { connection: 'kunde', source: 'a.txt', remotePath: '/srv/a.txt' });
    assert.equal(calls.uploads[0].connId, inherited._id.toString());
  });

  await check('eigener Slug schlägt gleichnamigen geerbten', async () => {
    const { ctrl, req, calls } = setup({ visible: [own, inheritedProd] });
    await ctrl.upload(req, { connection: 'prod', source: 'a.txt', remotePath: '/srv/a.txt' });
    assert.equal(calls.uploads[0].connId, own._id.toString());
  });

  await check('gleicher Slug bei mehreren geerbten -> 400 mit Ids', async () => {
    const other = conn('prod', { inheritedFromCustomerId: oid().toString() });
    const { ctrl, req, calls } = setup({ visible: [inheritedProd, other] });
    await assert.rejects(
      () => ctrl.upload(req, { connection: 'prod', source: 'a.txt', remotePath: '/x' }),
      (e) => statusOf(e) === 400 && e.message.includes(other._id.toString()),
    );
    assert.deepEqual(calls.uploads, []);
  });

  await check('Workspace gehört nicht zum Projekt des Tokens -> 403', async () => {
    const { ctrl, req, calls } = setup({ visible: [own], workspaceProject: OTHER_PROJECT });
    await assert.rejects(() => ctrl.list(req), (e) => statusOf(e) === 403);
    await assert.rejects(() => ctrl.upload(req, { connection: 'prod', source: 'a', remotePath: '/x' }), (e) => statusOf(e) === 403);
    assert.deepEqual(calls.uploads, []);
  });

  await check('list zeigt eigene + geerbte, ohne Secret-Referenzen', async () => {
    const { ctrl, req } = setup({ visible: [own, inherited] });
    const rows = await ctrl.list(req);
    assert.deepEqual(rows.map((r) => [r.slug, r.inherited]), [['prod', false], ['kunde', true]]);
    assert.ok(!('privateKeySecretId' in rows[0]));
  });

  await check('Upload: host: und host:dir/ behalten den Dateinamen, Audit als dg', async () => {
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

  await check('Download: Ziel, Dateiname und Größe gehen an den Sidecar; Verzeichnisquelle -> 400', async () => {
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

  await check('Fehlercodes werden zu 413 / 404 / 403 statt 500', async () => {
    let s = setup({ visible: [own], uploadError: 'upload_too_large: 20 > 10' });
    await assert.rejects(() => s.ctrl.upload(s.req, { connection: 'prod', source: 'a', remotePath: '/x' }), (e) => statusOf(e) === 413);
    s = setup({ visible: [own], downloadError: 'remote_not_found: /nope' });
    await assert.rejects(() => s.ctrl.download(s.req, { connection: 'prod', remotePath: '/nope', target: '.' }), (e) => statusOf(e) === 404);
    s = setup({ visible: [own], downloadError: 'tofu_not_accepted' });
    await assert.rejects(() => s.ctrl.download(s.req, { connection: 'prod', remotePath: '/x', target: '.' }), (e) => statusOf(e) === 403);
  });

  await check('Audit-Schema: dg braucht workspaceId statt userId, alle anderen weiter userId', () => {
    const Model = mongoose.model('SshAuditCheck', SshAuditSchema);
    const base = { connectionId: oid(), action: 'upload' };
    assert.equal(new Model({ ...base, sourceContext: 'dg', workspaceId: oid() }).validateSync(), undefined);
    assert.ok(new Model({ ...base, sourceContext: 'dg' }).validateSync()?.errors.workspaceId);
    assert.ok(new Model({ ...base, sourceContext: 'mcp' }).validateSync()?.errors.userId);
    assert.equal(new Model({ ...base, sourceContext: 'mcp', userId: oid() }).validateSync(), undefined);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
