#!/usr/bin/env node
/*
 * T-547: sidecar directory lifecycle.
 *
 * - WorkspacesService.remove destroys the sidecar dir of container workspaces,
 *   never of SSH workspaces, and swallows a sidecar failure.
 * - removeByProject destroys the container dirs of the deleted workspaces.
 * - sweepOrphans passes ALL record ids (any status/location) to the sidecar
 *   and reports totalBytes; the controller route defaults to a dry run and is
 *   admin-only.
 * - WorkspaceClient posts to /destroy and /orphans.
 *
 * Loads from dist/; run `npm run build` first. No database, no network.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function load(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.\n${err.message}`);
    process.exit(2);
  }
}
const { WorkspacesService } = load('workspaces/workspaces.service.js');
const { WorkspacesController } = load('workspaces/workspaces.controller.js');
const { WorkspaceClient } = load('workspaces/workspace-client.service.js');

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`ok  ${label}`); }
  catch (err) { failures += 1; console.error(`FAIL ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const OID = (n) => String(n).padStart(24, '0');
const exec = (v) => ({ exec: async () => v, lean() { return this; } });

function makeModel(docs) {
  const calls = { deleteMany: [], find: [] };
  return {
    calls,
    findById: (id) => exec(docs.find((d) => String(d._id) === String(id)) ?? null),
    findByIdAndDelete: (id) => exec(docs.find((d) => String(d._id) === String(id)) ?? null),
    find: (filter, proj) => {
      calls.find.push({ filter, proj });
      const ids = filter?._id?.$in?.map(String);
      return exec(ids ? docs.filter((d) => ids.includes(String(d._id))) : docs);
    },
    deleteMany: (filter) => { calls.deleteMany.push(filter); return exec({ deletedCount: docs.length }); },
  };
}
function makeClient({ failDestroy = false, orphans } = {}) {
  const c = {
    destroyed: [], listed: [],
    destroyDir: async (id) => { c.destroyed.push(id); if (failDestroy) throw new Error('sidecar down'); return { ok: true, existed: true }; },
    listOrphans: async (ids, cutoffSec, deleteIds) => { c.listed.push({ ids, cutoffSec, deleteIds }); return orphans ?? { orphans: [], deleted: [] }; },
  };
  return c;
}
const ws = (n, location, extra = {}) => ({ _id: OID(n), name: `w${n}`, location, projectId: OID(99), ...extra });
const flush = () => new Promise((r) => setImmediate(r));
const makeService = (docs, client) => new WorkspacesService(makeModel(docs), { emit() {} }, {}, undefined, client);

(async () => {
  await check('remove: container workspace -> destroyDir called with its id', async () => {
    const client = makeClient();
    await makeService([ws(1, 'container')], client).remove(OID(1));
    await flush();
    assert.deepEqual(client.destroyed, [OID(1)]);
  });

  await check('remove: legacy document without location counts as container', async () => {
    const client = makeClient();
    await makeService([ws(1, undefined)], client).remove(OID(1));
    await flush();
    assert.deepEqual(client.destroyed, [OID(1)]);
  });

  await check('remove: ssh workspace -> sidecar never called', async () => {
    const client = makeClient();
    await makeService([ws(2, 'ssh')], client).remove(OID(2));
    await flush();
    assert.deepEqual(client.destroyed, []);
  });

  await check('remove: sidecar failure is swallowed, delete succeeds', async () => {
    const client = makeClient({ failDestroy: true });
    await makeService([ws(1, 'container')], client).remove(OID(1));
    await flush();
    assert.deepEqual(client.destroyed, [OID(1)]);
  });

  await check('remove: works without a sidecar client (checks build the service bare)', async () => {
    await makeService([ws(1, 'container')], undefined).remove(OID(1));
  });

  await check('removeByProject: destroys container dirs only, after deleteMany', async () => {
    const client = makeClient();
    const docs = [ws(1, 'container'), ws(2, 'ssh'), ws(3, undefined)];
    const model = makeModel(docs);
    const order = [];
    const origDel = model.deleteMany;
    model.deleteMany = (f) => { order.push('deleteMany'); return origDel(f); };
    const origDestroy = client.destroyDir;
    client.destroyDir = (id) => { order.push(`destroy:${id}`); return origDestroy(id); };
    const svc = new WorkspacesService(model, { emit() {} }, {}, undefined, client);
    await svc.removeByProject(OID(99));
    await flush();
    assert.deepEqual(client.destroyed, [OID(1), OID(3)]);
    assert.equal(order[0], 'deleteMany');
    assert.equal(model.calls.deleteMany.length, 1);
  });

  await check('removeByProject: sidecar failure does not fail the cascade', async () => {
    const client = makeClient({ failDestroy: true });
    await makeService([ws(1, 'container'), ws(3, 'container')], client).removeByProject(OID(99));
    await flush();
    assert.equal(client.destroyed.length, 2);
  });

  await check('removeByProject: invalid project id is rejected before any query', async () => {
    const client = makeClient();
    const svc = makeService([ws(1, 'container')], client);
    await assert.rejects(() => svc.removeByProject('not-an-id'));
    assert.deepEqual(client.destroyed, []);
  });

  await check('remove: does not wait for a slow sidecar (fire and forget), failure of the whole call is logged only', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const client = makeClient();
    client.destroyDir = async (id) => { client.destroyed.push(id); await gate; return { ok: true, existed: true }; };
    const done = await Promise.race([
      makeService([ws(1, 'container')], client).remove(OID(1)).then(() => 'returned'),
      new Promise((r) => setTimeout(() => r('blocked'), 500)),
    ]);
    assert.equal(done, 'returned');
    await flush();
    assert.deepEqual(client.destroyed, [OID(1)]);
    release();
  });

  const SEC = (ms) => Math.floor(ms / 1000);
  await check('sweepOrphans dry run: passes every record id (any status/location), cutoff = read time - 300s, sums totalBytes', async () => {
    const client = makeClient({ orphans: { orphans: [{ id: OID(7), bytes: 10 }, { id: OID(8), bytes: 32 }], deleted: [] } });
    const docs = [ws(1, 'container', { status: 'active' }), ws(2, 'ssh', { status: 'archived' }), ws(3, 'container', { status: 'archived' })];
    const model = makeModel(docs);
    const svc = new WorkspacesService(model, { emit() {} }, {}, undefined, client);
    const before = Date.now();
    const res = await svc.sweepOrphans();
    const after = Date.now();
    assert.equal(client.listed.length, 1);
    assert.deepEqual(client.listed[0].ids, [OID(1), OID(2), OID(3)]);
    assert.equal(client.listed[0].deleteIds, undefined);
    assert.ok(client.listed[0].cutoffSec >= SEC(before) - 300 && client.listed[0].cutoffSec <= SEC(after) - 300);
    assert.deepEqual(model.calls.find[0].filter, {});
    assert.equal(res.totalBytes, 42);
  });

  await check('sweepOrphans delete: requires non-empty valid hex ids', async () => {
    for (const bad of [[], ['zz'], [OID(7), '../x'], [`${OID(7)}x`]]) {
      const client = makeClient();
      await assert.rejects(() => makeService([ws(1, 'container')], client).sweepOrphans(bad), (e) => e.getStatus() === 400);
      assert.deepEqual(client.listed, []);
    }
  });

  await check('sweepOrphans delete: re-checks Mongo for the ids (validated ObjectIds) and refuses with 409 when a record exists', async () => {
    const client = makeClient();
    const model = makeModel([ws(1, 'container')]);
    const svc = new WorkspacesService(model, { emit() {} }, {}, undefined, client);
    await assert.rejects(() => svc.sweepOrphans([OID(1)]), (e) => e.getStatus() === 409);
    assert.deepEqual(client.listed, []);
    assert.ok(model.calls.find[0].filter._id.$in[0] instanceof require('mongoose').Types.ObjectId);
  });

  await check('sweepOrphans delete: ids that have no record go to the sidecar as deleteIds', async () => {
    const client = makeClient({ orphans: { orphans: [{ id: OID(7), bytes: 5 }], deleted: [OID(7)] } });
    const svc = makeService([ws(1, 'container')], client);
    const res = await svc.sweepOrphans([OID(7)]);
    assert.deepEqual(client.listed[0].deleteIds, [OID(7)]);
    assert.deepEqual(client.listed[0].ids, [OID(1)]);
    assert.deepEqual(res.deleted, [OID(7)]);
  });

  await check('sweepOrphans: no records but dirs on disk -> 409 and nothing deleted', async () => {
    const client = makeClient({ orphans: { orphans: [{ id: OID(7), bytes: 5 }], deleted: [] } });
    await assert.rejects(() => makeService([], client).sweepOrphans(), (e) => e.getStatus() === 409);
    await assert.rejects(() => makeService([], client).sweepOrphans([OID(7)]), (e) => e.getStatus() === 409);
    assert.ok(client.listed.every((l) => l.deleteIds === undefined), 'sidecar was never asked to delete');
  });

  await check('sweepOrphans: no records and no dirs -> empty result', async () => {
    const res = await makeService([], makeClient()).sweepOrphans();
    assert.deepEqual(res.orphans, []);
    assert.equal(res.totalBytes, 0);
  });

  await check('controller sweep: default is a dry run; delete needs ids', async () => {
    const calls = [];
    const svc = { sweepOrphans: async (d) => { calls.push(d); return { orphans: [], deleted: [], totalBytes: 0 }; } };
    const ctrl = new WorkspacesController(svc, {}, {}, {}, {}, {}, {});
    await ctrl.sweepOrphans({});
    await ctrl.sweepOrphans({ delete: false, ids: [OID(1)] });
    assert.deepEqual(calls, [undefined, undefined]);
    assert.throws(() => ctrl.sweepOrphans({ delete: true }), (e) => e.getStatus() === 400);
    assert.throws(() => ctrl.sweepOrphans({ delete: true, ids: [] }), (e) => e.getStatus() === 400);
    await ctrl.sweepOrphans({ delete: true, ids: [OID(1)] });
    assert.deepEqual(calls, [undefined, undefined, [OID(1)]]);
  });

  await check('controller sweep: route is POST workspaces/orphans/sweep and admin-only', async () => {
    const proto = WorkspacesController.prototype.sweepOrphans;
    assert.equal(Reflect.getMetadata('path', proto), 'orphans/sweep');
    assert.equal(Reflect.getMetadata('method', proto), 1); // RequestMethod.POST
    const ttl = WorkspacesController.prototype.triggerTtlSweep;
    const keys = Reflect.getMetadataKeys(ttl).filter((k) => /roles/i.test(String(k)));
    assert.ok(keys.length > 0, 'ttl/sweep carries a roles key');
    for (const k of keys) assert.deepEqual(Reflect.getMetadata(k, proto), Reflect.getMetadata(k, ttl));
  });

  await check('WorkspaceClient: /destroy and /orphans bodies', async () => {
    const posts = [];
    const http = { post: (url, body) => { posts.push({ url, body }); return { subscribe(o) { o.next({ data: { ok: true } }); o.complete(); return { unsubscribe() {} }; } }; } };
    process.env.WORKSPACE_API_TOKEN = 't';
    const client = new WorkspaceClient(http);
    await client.destroyDir(OID(1));
    await client.listOrphans([OID(1)], 123, [OID(2)]);
    await client.listOrphans([OID(1)], 123);
    assert.ok(posts[0].url.endsWith('/destroy'));
    assert.deepEqual(posts[0].body, { workspaceId: OID(1) });
    assert.ok(posts[1].url.endsWith('/orphans'));
    assert.deepEqual(posts[1].body, { knownIds: [OID(1)], cutoffSec: 123, delete: true, deleteIds: [OID(2)] });
    assert.deepEqual(posts[2].body, { knownIds: [OID(1)], cutoffSec: 123 });
  });

  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
})();
