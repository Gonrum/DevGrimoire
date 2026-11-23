#!/usr/bin/env node
/*
 * SSH workspace data model (Task 1): creation validation, lifecycle guards,
 * access resolution, response enrichment, IDE gate.
 *
 * Loads from dist/; run `npm run build` first. No database, no network.
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
const nm = (m) => require(path.resolve(__dirname, '..', 'node_modules', m));

const { normalizeRemotePath } = loadCompiled('workspaces/remote-path.js');
const { SshWorkspaceAccess } = loadCompiled('workspaces/ssh-workspace-access.service.js');
const { WorkspacesService } = loadCompiled('workspaces/workspaces.service.js');
const { WorkspacesController } = loadCompiled('workspaces/workspaces.controller.js');
const { WorkspaceFsController } = loadCompiled('workspaces/workspace-fs.controller.js');
const { WorkspaceFsBackends } = loadCompiled('workspaces/fs/workspace-fs-backends.service.js');
const { WorkspaceTtlScheduler } = loadCompiled('workspaces/workspace-ttl.scheduler.js');
const { RequestContext } = loadCompiled('common/request-context.js');
const { CreateWorkspaceDto } = loadCompiled('workspaces/dto/create-workspace.dto.js');
const { UpdateWorkspaceDto } = loadCompiled('workspaces/dto/update-workspace.dto.js');
const mongoose = nm('mongoose');
const { validate } = nm('class-validator');
const { plainToInstance } = nm('class-transformer');

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const statusOf = (e) => (typeof e.getStatus === 'function' ? e.getStatus() : e.status);
const rejectsWith = async (fn, status, re) => {
  let err;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected a rejection');
  assert.equal(statusOf(err), status, `status ${statusOf(err)}: ${err.message}`);
  if (re) assert.match(err.message, re);
};
const oid = () => new mongoose.Types.ObjectId();
const PROJECT = oid();
const CONN = oid();

// ---- fakes -------------------------------------------------------------------

function makeConn(over = {}) {
  return { _id: CONN, label: 'prod', host: 'h.example', port: 2222, username: 'deploy', projectId: PROJECT, ...over };
}
function makeSsh(conns, usableIds) {
  const calls = { byProject: 0, byIds: 0 };
  return {
    calls,
    findById: async (id) => {
      const c = conns.find((x) => String(x._id) === String(id));
      if (!c) { const { NotFoundException } = nm('@nestjs/common'); throw new NotFoundException('SshConnection not found'); }
      return c;
    },
    findByProjectId: async () => { calls.byProject += 1; return conns.filter((c) => usableIds.includes(String(c._id))); },
    findManyByIds: async (ids) => { calls.byIds += 1; return conns.filter((c) => ids.includes(String(c._id))); },
  };
}
function makeModel(docs = []) {
  const state = { created: [], filter: null };
  return {
    state,
    create: async (d) => { state.created.push(d); return { ...d, toJSON() { return { ...d }; } }; },
    find: (filter) => {
      state.filter = filter;
      const out = docs.filter((d) => {
        if (filter.location && filter.location.$ne !== undefined && d.location === filter.location.$ne) return false;
        return true;
      });
      const chain = { sort: () => chain, exec: async () => out };
      return chain;
    },
  };
}
const events = { emit() {} };
const dto = (over = {}) => ({ projectId: PROJECT.toString(), name: 'w1', ...over });

(async () => {
  // ---- normalizeRemotePath
  await check('normalizeRemotePath collapses duplicate and trailing slashes', () => {
    assert.equal(normalizeRemotePath('/srv//app/'), '/srv/app');
  });
  for (const bad of ['srv', '/', '//', '/a/../b', '/a\0b', '~/x', 42, undefined, '/' + 'a'.repeat(4096)]) {
    await check(`normalizeRemotePath rejects ${JSON.stringify(typeof bad === 'string' ? bad.slice(0, 12) : bad)}`, () => {
      let err;
      try { normalizeRemotePath(bad); } catch (e) { err = e; }
      assert.ok(err && statusOf(err) === 400);
    });
  }

  // ---- DTOs
  await check('create DTO accepts ssh fields, rejects bad location / id', async () => {
    const ok = plainToInstance(CreateWorkspaceDto, { ...dto(), location: 'ssh', sshConnectionId: CONN.toString(), remotePath: '/srv/app' });
    assert.equal((await validate(ok)).length, 0);
    const bad = plainToInstance(CreateWorkspaceDto, { ...dto(), location: 'cloud', sshConnectionId: 'x' });
    assert.ok((await validate(bad)).length >= 2);
  });
  await check('update DTO whitelist strips location / sshConnectionId / remotePath', async () => {
    const inst = plainToInstance(UpdateWorkspaceDto, { name: 'x', location: 'ssh', sshConnectionId: CONN.toString(), remotePath: '/a' });
    await validate(inst, { whitelist: true });
    for (const k of ['location', 'sshConnectionId', 'remotePath']) assert.ok(!(k in inst), k);
  });

  // ---- create
  const sshOpts = { location: 'ssh', sshConnectionId: CONN.toString(), remotePath: '/srv//app/' };
  await check('create ssh with repoUrl -> 400', async () => {
    const svc = new WorkspacesService(makeModel(), events, makeSsh([makeConn()], [String(CONN)]));
    await rejectsWith(() => svc.create(dto({ ...sshOpts, repoUrl: 'https://x/y.git' })), 400);
  });
  await check('create ssh with branch or gitRepoId -> 400', async () => {
    const svc = new WorkspacesService(makeModel(), events, makeSsh([makeConn()], [String(CONN)]));
    await rejectsWith(() => svc.create(dto({ ...sshOpts, branch: 'dev' })), 400);
    await rejectsWith(() => svc.create(dto({ ...sshOpts, gitRepoId: 'abc' })), 400);
  });
  await check('create ssh without remotePath -> 400; without connection id -> 400', async () => {
    const svc = new WorkspacesService(makeModel(), events, makeSsh([makeConn()], [String(CONN)]));
    await rejectsWith(() => svc.create(dto({ location: 'ssh', sshConnectionId: CONN.toString() })), 400);
    await rejectsWith(() => svc.create(dto({ location: 'ssh', remotePath: '/srv/a' })), 400);
  });
  await check('create ssh with unknown connection -> 400', async () => {
    const svc = new WorkspacesService(makeModel(), events, makeSsh([], []));
    await rejectsWith(() => svc.create(dto(sshOpts)), 400);
  });
  await check('create ssh with connection not usable for the project -> 400', async () => {
    const model = makeModel();
    const svc = new WorkspacesService(model, events, makeSsh([makeConn()], []));
    await rejectsWith(() => svc.create(dto(sshOpts)), 400);
    assert.equal(model.state.created.length, 0);
  });
  await check('create ssh with bad remotePath -> 400', async () => {
    const svc = new WorkspacesService(makeModel(), events, makeSsh([makeConn()], [String(CONN)]));
    await rejectsWith(() => svc.create(dto({ ...sshOpts, remotePath: '/a/../b' })), 400);
  });
  await check('create ssh: actor without access to the connection -> 403', async () => {
    const { ForbiddenException } = nm('@nestjs/common');
    const ssh = makeSsh([makeConn()], [String(CONN)]);
    ssh.findById = async () => { throw new ForbiddenException('nope'); };
    const svc = new WorkspacesService(makeModel(), events, ssh);
    await rejectsWith(() => svc.create(dto(sshOpts)), 403);
  });
  await check('create ssh valid -> path === normalized remotePath, location ssh, no repo fields', async () => {
    const model = makeModel();
    const svc = new WorkspacesService(model, events, makeSsh([makeConn()], [String(CONN)]));
    const ws = await svc.create(dto(sshOpts));
    assert.equal(ws.location, 'ssh');
    assert.equal(ws.path, '/srv/app');
    assert.equal(ws.remotePath, '/srv/app');
    assert.equal(String(ws.sshConnectionId), String(CONN));
    assert.equal(ws.repoUrl, undefined);
  });
  await check('create ssh calls verifyRemoteDir hook at the end; its error propagates; unset -> skipped', async () => {
    const model = makeModel();
    const svc = new WorkspacesService(model, events, makeSsh([makeConn()], [String(CONN)]));
    const seen = [];
    svc.verifyRemoteDir = async (conn, p) => { seen.push([String(conn._id), p]); };
    await svc.create(dto(sshOpts));
    assert.deepEqual(seen, [[String(CONN), '/srv/app']]);
    svc.verifyRemoteDir = async () => { throw new (nm('@nestjs/common').BadRequestException)('Verzeichnis fehlt'); };
    const before = model.state.created.length;
    await rejectsWith(() => svc.create(dto({ ...sshOpts, name: 'w2' })), 400, /Verzeichnis fehlt/);
    assert.equal(model.state.created.length, before);
  });
  await check('create container (no location) keeps legacy shape', async () => {
    const model = makeModel();
    const svc = new WorkspacesService(model, events, makeSsh([], []));
    const ws = await svc.create(dto({ repoUrl: 'https://x/y.git' }));
    assert.equal(ws.location, 'container');
    assert.match(ws.path, /^\/workspaces\/[a-f0-9]{24}\/$/);
    assert.equal(ws.sshConnectionId, undefined);
    assert.equal(ws.remotePath, undefined);
  });
  await check('create container with sshConnectionId/remotePath -> 400', async () => {
    const svc = new WorkspacesService(makeModel(), events, makeSsh([], []));
    await rejectsWith(() => svc.create(dto({ remotePath: '/srv/a' })), 400);
    await rejectsWith(() => svc.create(dto({ sshConnectionId: CONN.toString() })), 400);
  });

  // ---- findInactive
  await check('findInactive excludes ssh, keeps container and legacy docs', async () => {
    const docs = [{ location: 'ssh', n: 'a' }, { location: 'container', n: 'b' }, { n: 'legacy' }];
    const model = makeModel(docs);
    const svc = new WorkspacesService(model, events, makeSsh([], []));
    const out = await svc.findInactive('active', new Date());
    assert.deepEqual(out.map((d) => d.n), ['b', 'legacy']);
    assert.deepEqual(model.state.filter.location, { $ne: 'ssh' });
  });
  await check('TTL sweep never calls sidecar cleanup for an ssh workspace', async () => {
    const ssh = { _id: oid(), name: 's', location: 'ssh' };
    const cont = { _id: oid(), name: 'c', location: 'container' };
    const cleaned = [];
    const wsSvc = {
      findInactive: async (st) => (st === 'archived' ? [ssh, cont] : []),
      remove: async () => undefined, archive: async () => undefined,
    };
    const client = { isConfigured: () => true, cleanup: async (id) => { cleaned.push(id); } };
    const settings = { get: async () => undefined };
    const notifications = { create: async () => undefined };
    const sched = new WorkspaceTtlScheduler(wsSvc, client, settings, notifications);
    await sched.sweep();
    assert.deepEqual(cleaned, [String(cont._id)]);
    assert.ok(!cleaned.includes(String(ssh._id)));
  });

  // ---- SshWorkspaceAccess
  const wsRef = { projectId: PROJECT, sshConnectionId: CONN };
  await check('access: connection gone -> 409 with the documented text', async () => {
    const acc = new SshWorkspaceAccess(makeSsh([], []));
    await rejectsWith(() => acc.resolve(wsRef), 409, /existiert nicht mehr/);
  });
  await check('access: not usable for project -> 409', async () => {
    const acc = new SshWorkspaceAccess(makeSsh([makeConn()], []));
    await rejectsWith(() => acc.resolve(wsRef), 409);
  });
  await check('access: usable -> returns the connection; result cached, invalidate clears', async () => {
    const ssh = makeSsh([makeConn()], [String(CONN)]);
    const acc = new SshWorkspaceAccess(ssh);
    const c = await acc.resolve(wsRef);
    assert.equal(String(c._id), String(CONN));
    await acc.resolve(wsRef);
    assert.equal(ssh.calls.byProject, 1);
    acc.invalidate();
    await acc.resolve(wsRef);
    assert.equal(ssh.calls.byProject, 2);
  });
  await check('access: actor without access -> 403 (checked on every call, cache or not)', async () => {
    const ssh = makeSsh([makeConn()], [String(CONN)]);
    const acc = new SshWorkspaceAccess(ssh);
    await acc.resolve(wsRef);
    const actor = { userId: 'u', username: 'u', role: 'user', projectScopeMode: 'selected', allowedProjectIds: [] };
    await rejectsWith(() => RequestContext.run(actor, undefined, () => acc.resolve(wsRef)), 403);
  });

  // ---- controller enrichment
  const sshWs = () => ({ _id: oid(), projectId: PROJECT, name: 's', location: 'ssh', sshConnectionId: CONN, remotePath: '/srv/app', path: '/srv/app', toJSON() { return { _id: this._id, name: this.name, location: 'ssh', sshConnectionId: CONN, remotePath: '/srv/app' }; } });
  const contWs = () => ({ _id: oid(), projectId: PROJECT, name: 'c', location: 'container', toJSON() { return { _id: this._id, name: 'c', location: 'container' }; } });
  const makeCtrl = (list, ssh) => {
    const svc = { findByProject: async () => list, findById: async () => list[0], create: async () => list[0] };
    return new WorkspacesController(svc, {}, {}, {}, {}, {}, ssh);
  };
  await check('controller list: ssh enrichment, one batch lookup, no secrets, containers untouched', async () => {
    const ssh = makeSsh([makeConn({ privateKeySecretId: oid(), passwordSecretId: oid() })], [String(CONN)]);
    const ctrl = makeCtrl([sshWs(), sshWs(), contWs()], ssh);
    const out = await ctrl.findAll(PROJECT.toString());
    assert.equal(ssh.calls.byIds, 1);
    assert.deepEqual(out[0].ssh, { connectionId: String(CONN), label: 'prod', username: 'deploy', host: 'h.example', port: 2222 });
    assert.ok(!('ssh' in out[2]));
    assert.ok(!JSON.stringify(out).includes('SecretId'));
  });
  await check('controller get/create: ssh enrichment; gone connection -> ssh: null', async () => {
    const ctrl = makeCtrl([sshWs()], makeSsh([], []));
    assert.equal((await ctrl.findOne('x')).ssh, null);
    assert.equal((await ctrl.create({})).ssh, null);
    const ctrl2 = makeCtrl([sshWs()], makeSsh([makeConn()], []));
    assert.equal((await ctrl2.findOne('x')).ssh.label, 'prod');
    assert.equal((await ctrl2.create({})).ssh.host, 'h.example');
  });

  // ---- IDE gate
  await check('fs gate: ssh workspace -> connection access check (409 when gone), never ensureDir / sidecar', async () => {
    const ws = { _id: oid(), projectId: PROJECT, status: 'active', location: 'ssh' };
    let sidecar = 0;
    let resolved = 0;
    const client = new Proxy({}, { get: () => async () => { sidecar += 1; return {}; } });
    const svc = { findById: async () => ws, touchThrottled() {} };
    const access = { resolve: async () => { resolved += 1; throw new (nm('@nestjs/common').ConflictException)('SSH-Verbindung dieser Werkstatt existiert nicht mehr'); } };
    const ctrl = new WorkspaceFsController(svc, new WorkspaceFsBackends(client), { create: async () => undefined }, { get: async () => ({ editorMaxBytes: 5 * 1024 * 1024, downloadMaxBytes: 2 * 1024 ** 3 }) }, { issue: () => 't', consume: () => null }, { resolve: async () => undefined }, access);
    await rejectsWith(() => RequestContext.run({ userId: 'u', username: 'u', role: 'admin' }, undefined, () => ctrl.tree(ws._id.toString(), '.')), 409, /existiert nicht mehr/);
    assert.equal(resolved, 1);
    assert.equal(sidecar, 0);
  });

  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
})();
