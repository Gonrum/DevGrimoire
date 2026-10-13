#!/usr/bin/env node
/*
 * dg-kube-Scope-Check (C-3, 2026-10-13).
 *
 * Seit C-3 gibt es keine Kube-Sessions mehr im Workspace-Sidecar; aus der
 * Shell geht Cluster-Zugriff nur noch über `dg kube` → Backend. Die Route ist
 * @Public (dg-Token statt Nutzer-JWT), RequestContext hat keinen Actor, und
 * `KubeClustersService.findById()` prüft ohne Actor NICHTS. Die
 * Projektprüfung im Controller ist damit die einzige Grenze — dieser Check
 * hält sie fest:
 *   - fremder Cluster (anderes Projekt, kunden-gebunden) -> 404, kein Zugriff
 *   - eigener Cluster per Id und per Slug -> Zugriff, Audit als 'dg'
 *   - ohne --cluster: genau einer -> der; mehrere -> 400 mit Slugs; keiner -> 404
 *   - Workspace gehört nicht (mehr) zum Projekt des Tokens -> 403
 *   - Audit-Schema: 'dg' ohne userId gültig, aber nur mit workspaceId
 *   - Terminal-Token lebt 8 h, Exec-Token weiter 1 h
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { WorkspaceCliKubeController } = loadCompiled('workspaces/workspace-cli-kube.controller.js');
const { WorkspaceCliTokenService, TERMINAL_TOKEN_TTL } = loadCompiled('workspaces/workspace-cli-token.service.js');
const { KubeAuditSchema } = loadCompiled('kube/schemas/kube-audit.schema.js');
const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));
const { JwtService } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/jwt'));

const EXPECTED_CHECKS = 9;

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

function cluster(projectId, slug, extra = {}) {
  return { _id: oid(), projectId: projectId ? new mongoose.Types.ObjectId(projectId) : undefined, slug, label: slug, ...extra };
}

/** Controller mit In-Memory-Fakes; `calls` hält fest, welcher Cluster wirklich angefragt wurde. */
function setup({ clusters, workspaceProject = PROJECT }) {
  const calls = { resources: [], audit: [] };
  const byId = new Map(clusters.map((c) => [c._id.toString(), c]));
  const notFound = () => Object.assign(new Error('not found'), { status: 404 });
  const ctrl = new WorkspaceCliKubeController(
    { findById: async () => ({ projectId: new mongoose.Types.ObjectId(workspaceProject) }) },
    {
      // Wie das Original ohne Actor: KEINE Scope-Prüfung.
      findById: async (id) => { if (!byId.has(id)) throw notFound(); return byId.get(id); },
      findBySlug: async (slug, scope) => {
        const hit = clusters.find((c) => c.slug === slug && String(c.projectId) === scope.projectId);
        if (!hit) throw notFound();
        return hit;
      },
      findByProjectId: async (p) => clusters.filter((c) => String(c.projectId) === p),
    },
    {},
    {
      list: async (clusterId) => { calls.resources.push(clusterId); return []; },
      get: async (clusterId) => { calls.resources.push(clusterId); return {}; },
      describe: async (clusterId) => { calls.resources.push(clusterId); return {}; },
      events: async (clusterId) => { calls.resources.push(clusterId); return []; },
    },
    {},
    { record: async (e) => { calls.audit.push(e); } },
  );
  const req = { workspaceCli: { workspaceId: WORKSPACE, projectId: PROJECT } };
  return { ctrl, req, calls };
}

(async () => {
  const own = cluster(PROJECT, 'prod');
  const foreign = cluster(OTHER_PROJECT, 'prod');
  const customerBound = cluster(undefined, 'kunde', { customerId: oid() });

  await check('fremder Cluster per Id -> 404, keine Anfrage an den Cluster', async () => {
    const { ctrl, req, calls } = setup({ clusters: [own, foreign] });
    await assert.rejects(() => ctrl.get(req, { kind: 'Pod', cluster: foreign._id.toString() }), (e) => statusOf(e) === 404);
    assert.deepEqual(calls.resources, []);
    assert.deepEqual(calls.audit, []);
  });

  await check('kunden-gebundener Cluster per Id -> 404', async () => {
    const { ctrl, req, calls } = setup({ clusters: [own, customerBound] });
    await assert.rejects(() => ctrl.describe(req, { kind: 'Pod', name: 'x', namespace: 'd', cluster: customerBound._id.toString() }), (e) => statusOf(e) === 404);
    assert.deepEqual(calls.resources, []);
  });

  await check('eigener Cluster per Id -> Zugriff, Audit als dg mit workspaceId, ohne userId', async () => {
    const { ctrl, req, calls } = setup({ clusters: [own, foreign] });
    await ctrl.get(req, { kind: 'Pod', cluster: own._id.toString(), namespace: 'default' });
    assert.deepEqual(calls.resources, [own._id.toString()]);
    assert.equal(calls.audit.length, 1);
    assert.equal(calls.audit[0].sourceContext, 'dg');
    assert.equal(calls.audit[0].workspaceId, WORKSPACE);
    assert.equal(calls.audit[0].userId, undefined);
    assert.equal(calls.audit[0].action, 'list');
  });

  await check('Slug wird im Projekt des Tokens aufgelöst, nicht im gleichnamigen fremden', async () => {
    const { ctrl, req, calls } = setup({ clusters: [foreign, own] });
    await ctrl.events(req, { cluster: 'prod' });
    assert.deepEqual(calls.resources, [own._id.toString()]);
  });

  await check('ohne --cluster: einer -> der, mehrere -> 400 mit Slugs, keiner -> 404', async () => {
    let s = setup({ clusters: [own, foreign] });
    await s.ctrl.get(s.req, { kind: 'Node' });
    assert.deepEqual(s.calls.resources, [own._id.toString()]);
    s = setup({ clusters: [own, cluster(PROJECT, 'staging')] });
    await assert.rejects(() => s.ctrl.get(s.req, { kind: 'Node' }), (e) => statusOf(e) === 400 && /prod, staging/.test(e.message));
    s = setup({ clusters: [foreign] });
    await assert.rejects(() => s.ctrl.get(s.req, { kind: 'Node' }), (e) => statusOf(e) === 404);
    assert.deepEqual(s.calls.resources, []);
  });

  await check('Workspace gehört nicht zum Projekt des Tokens -> 403', async () => {
    const { ctrl, req, calls } = setup({ clusters: [own], workspaceProject: OTHER_PROJECT });
    await assert.rejects(() => ctrl.get(req, { kind: 'Pod', cluster: 'prod' }), (e) => statusOf(e) === 403);
    await assert.rejects(() => ctrl.listClusters(req), (e) => statusOf(e) === 403);
    assert.deepEqual(calls.resources, []);
  });

  await check('clusters listet nur die des eigenen Projekts, ohne Credentials', async () => {
    const { ctrl, req } = setup({ clusters: [own, foreign, customerBound] });
    const rows = await ctrl.listClusters(req);
    assert.deepEqual(rows.map((r) => r.clusterId), [own._id.toString()]);
    assert.ok(!('kubeconfigSecretId' in rows[0]));
  });

  await check('Audit-Schema: dg braucht workspaceId statt userId, alle anderen weiter userId', () => {
    const Model = mongoose.model('KubeAuditCheck', KubeAuditSchema);
    const base = { clusterId: oid(), action: 'list' };
    assert.equal(new Model({ ...base, sourceContext: 'dg', workspaceId: oid() }).validateSync(), undefined);
    assert.ok(new Model({ ...base, sourceContext: 'dg' }).validateSync()?.errors.workspaceId);
    assert.ok(new Model({ ...base, sourceContext: 'mcp' }).validateSync()?.errors.userId);
    assert.equal(new Model({ ...base, sourceContext: 'mcp', userId: oid() }).validateSync(), undefined);
  });

  await check('Terminal-Token lebt 8 h, Exec-Token 1 h', () => {
    const svc = new WorkspaceCliTokenService(new JwtService({ secret: 'x'.repeat(32) }));
    const life = (t) => { const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64url')); return p.exp - p.iat; };
    assert.equal(TERMINAL_TOKEN_TTL, '8h');
    assert.equal(life(svc.mint(WORKSPACE, PROJECT, TERMINAL_TOKEN_TTL)), 8 * 3600);
    assert.equal(life(svc.mint(WORKSPACE, PROJECT)), 3600);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
