#!/usr/bin/env node
/*
 * dg req scope check (`dg req list|send|history`).
 *
 * The route is @Public (dg token instead of a user JWT), RequestContext has
 * no actor, and HttpRequestsService / EnvironmentsService check NOTHING
 * without one. The controller's resolution (the project's own requests and
 * environments) is therefore the only boundary — this check pins it:
 *   - foreign request by id/name -> 404, nothing sent
 *   - customer-bound environment -> 404, nothing sent
 *   - workspace no longer belongs to the token's project -> 403
 *   - terminal output is the MASKED history copy, not the live body
 *   - list never returns saved auth/headers/body
 *   - name lookup: exact, case-insensitive, collection/name, ambiguity -> 400
 *   - `-o`: streams into the workspace; non-2xx writes no file
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

const { WorkspaceCliReqController } = loadCompiled('workspaces/workspace-cli-req.controller.js');
const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

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

const colA = { _id: oid(), name: 'Auth', projectId: new mongoose.Types.ObjectId(PROJECT) };
const colB = { _id: oid(), name: 'Orders', projectId: new mongoose.Types.ObjectId(PROJECT) };

function savedReq(name, col, projectId = PROJECT) {
  return {
    _id: oid(), name, method: 'GET', url: '{{base}}/x', collectionId: col._id,
    projectId: new mongoose.Types.ObjectId(projectId),
    auth: { type: 'bearer', token: 'PLAINTEXT-TOKEN' },
    headers: [{ name: 'X-Key', value: 'k' }],
  };
}

const login = savedReq('Login', colA);
const listB = savedReq('List', colB);
const listA = savedReq('List', colA);
const foreign = savedReq('Fremd', colA, OTHER_PROJECT);
const envDev = { _id: oid(), name: 'dev', projectId: new mongoose.Types.ObjectId(PROJECT) };
const envCustomer = { _id: oid(), name: 'kunde', customerId: oid() };

function setup({ workspaceProject = PROJECT, upstreamStatus = 200 } = {}) {
  const calls = { sent: [], streams: [], writes: [], touched: 0 };
  const ctrl = new WorkspaceCliReqController(
    {
      findById: async () => ({ projectId: new mongoose.Types.ObjectId(workspaceProject) }),
      touch: async () => { calls.touched += 1; },
    },
    {
      writeStream: async (ws, target, source, opts) => {
        for await (const _chunk of source) { /* drain */ }
        calls.writes.push({ ws, target, opts });
        return { ok: true, path: target.endsWith('/') || target === '.' ? `${target === '.' ? '' : target}${opts.fileName}` : target, size: 3 };
      },
    },
    {
      listCollections: async (p) => (p === PROJECT ? [colA, colB] : []),
      // Foreign request included on purpose: the fake behaves like the real
      // service without an actor, which filters nothing.
      listRequests: async () => [login, listA, listB, foreign],
      send: async (id, opts) => {
        calls.sent.push({ id, opts });
        return { historyId: 'h1', ok: true, body: 'LIVE secret=S3CR3T', unresolvedVariables: [] };
      },
      getHistoryEntry: async () => ({
        method: 'GET', url: 'https://api/x', environmentName: 'dev', ok: true, status: 200, statusText: 'OK',
        durationMs: 7, contentType: 'text/plain', responseHeaders: [{ name: 'a', value: 'b' }],
        bodyText: 'LIVE secret=***', truncated: false, bodySize: 18,
      }),
      listHistory: async (id, limit) => [{ _id: oid(), sentAt: new Date(), method: 'GET', url: 'u', ok: true, status: 200, durationMs: 1, bodySize: 1, _limit: limit, _id2: id }],
      openStream: async (id, opts) => {
        calls.streams.push({ id, opts });
        return {
          upstream: new globalThis.Response('abc', { status: upstreamStatus, headers: { 'content-length': '3' } }),
          body: Readable.from([Buffer.from('abc')]),
          filename: 'report.pdf',
        };
      },
    },
    { findByProject: async (p) => (p === PROJECT ? [envDev, envCustomer] : []) },
  );
  const req = { workspaceCli: { workspaceId: WORKSPACE, projectId: PROJECT } };
  return { ctrl, req, calls };
}

(async () => {
  await check('foreign request by id and by name -> 404, nothing sent', async () => {
    const { ctrl, req, calls } = setup();
    await assert.rejects(() => ctrl.send(req, { request: foreign._id.toString() }), (e) => statusOf(e) === 404);
    await assert.rejects(() => ctrl.send(req, { request: 'Fremd' }), (e) => statusOf(e) === 404);
    await assert.rejects(() => ctrl.history(req, { request: foreign._id.toString() }), (e) => statusOf(e) === 404);
    assert.deepEqual(calls.sent, []);
  });

  await check('customer-bound environment -> 404, nothing sent; own environment passes its id', async () => {
    const { ctrl, req, calls } = setup();
    await assert.rejects(() => ctrl.send(req, { request: 'Login', environment: 'kunde' }), (e) => statusOf(e) === 404);
    await assert.rejects(() => ctrl.send(req, { request: 'Login', environment: envCustomer._id.toString() }), (e) => statusOf(e) === 404);
    assert.deepEqual(calls.sent, []);
    await ctrl.send(req, { request: 'Login', environment: 'DEV' });
    assert.equal(calls.sent[0].opts.environmentId, envDev._id.toString());
  });

  await check('workspace moved to another project -> 403', async () => {
    const { ctrl, req, calls } = setup({ workspaceProject: OTHER_PROJECT });
    await assert.rejects(() => ctrl.send(req, { request: 'Login' }), (e) => statusOf(e) === 403);
    await assert.rejects(() => ctrl.list(req, {}), (e) => statusOf(e) === 403);
    assert.deepEqual(calls.sent, []);
  });

  await check('send returns the masked history body, never the live body', async () => {
    const { ctrl, req, calls } = setup();
    const res = await ctrl.send(req, { request: 'login' });
    assert.equal(res.body, 'LIVE secret=***');
    assert.ok(!JSON.stringify(res).includes('S3CR3T'));
    assert.equal(res.status, 200);
    assert.equal(calls.touched, 1);
  });

  await check('list: own requests only, no auth/headers, customer env hidden', async () => {
    const { ctrl, req } = setup();
    const res = await ctrl.list(req, {});
    const json = JSON.stringify(res);
    assert.ok(!json.includes('PLAINTEXT-TOKEN'));
    assert.ok(!json.includes('X-Key'));
    assert.ok(!json.includes('Fremd'));
    assert.deepEqual(res.environments.map((e) => e.name), ['dev']);
    assert.deepEqual(res.collections.map((c) => c.requests.map((r) => r.name)), [['Login', 'List'], ['List']]);
    const only = await ctrl.list(req, { collection: 'orders' });
    assert.deepEqual(only.collections.map((c) => c.name), ['Orders']);
  });

  await check('ambiguous name -> 400; collection/name and id resolve it', async () => {
    const { ctrl, req, calls } = setup();
    await assert.rejects(() => ctrl.send(req, { request: 'List' }), (e) => statusOf(e) === 400);
    await ctrl.send(req, { request: 'Orders/List' });
    await ctrl.send(req, { request: listA._id.toString() });
    assert.deepEqual(calls.sent.map((c) => c.id), [listB._id.toString(), listA._id.toString()]);
  });

  await check('-o streams into the workspace with the server file name', async () => {
    const { ctrl, req, calls } = setup();
    const res = await ctrl.send(req, { request: 'Login', output: 'out/', createDirs: true });
    assert.equal(res.ok, true);
    assert.equal(res.output, 'out/report.pdf');
    assert.equal(calls.writes[0].ws, WORKSPACE);
    assert.equal(calls.writes[0].opts.createDirs, true);
    assert.deepEqual(calls.sent, []);
  });

  await check('-o with a non-2xx response writes no file and returns no body', async () => {
    const { ctrl, req, calls } = setup({ upstreamStatus: 401 });
    const res = await ctrl.send(req, { request: 'Login', output: 'a.bin' });
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
    assert.deepEqual(calls.writes, []);
    assert.ok(!('body' in res));
  });

  await check('history caps the limit default at 10 and resolves by name', async () => {
    const { ctrl, req } = setup();
    const rows = await ctrl.history(req, { request: 'Login' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 200);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Expected ${EXPECTED_CHECKS} checks, ran ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
