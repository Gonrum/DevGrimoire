#!/usr/bin/env node
/*
 * Download tickets for `GET /workspaces/:id/fs/raw?ticket=`.
 *
 *  - service: random opaque ticket, single use, bound to workspace + path,
 *    expires (injected clock), pruned on access
 *  - guard: a ticket route is reachable without Bearer ONLY for a valid
 *    ticket bound to this workspace + path; used / expired / foreign -> 401;
 *    a route without @AcceptsDownloadTicket never takes a ticket; a Bearer
 *    header keeps the normal path
 *  - controller: download-ticket issues a URL bound to the path (after a
 *    preflight that surfaces 404/413), raw?ticket re-resolves the actor and
 *    streams as that user, second use -> 401, wrong path -> 401
 *  - actor service: inactive user / revoked key -> 401, no write permission -> 403
 *
 * Loads from dist/; run `npm run build` first. No database, no network.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { Readable, PassThrough } = require('node:stream');
const { Reflector } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/core'));
require(path.resolve(__dirname, '..', 'node_modules', 'reflect-metadata'));
const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const load = (rel) => require(path.resolve(__dirname, '..', 'dist', rel));
const { DownloadTicketService } = load('common/download-ticket.service.js');
const { JwtAuthGuard } = load('auth/guards/jwt-auth.guard.js');
const { ACCEPTS_DOWNLOAD_TICKET_KEY } = load('auth/decorators/accepts-download-ticket.decorator.js');
const { WorkspaceFsController } = load('workspaces/workspace-fs.controller.js');
const { WorkspacesService } = load('workspaces/workspaces.service.js');
const { DownloadActorService } = load('workspaces/download-actor.service.js');
const { RequestContext } = load('common/request-context.js');

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`ok  ${label}`); }
  catch (err) { failures += 1; console.error(`FAIL ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const statusOf = (e) => (typeof e.getStatus === 'function' ? e.getStatus() : e.status);
const rejectsWith = (fn, status) => assert.rejects(fn, (e) => statusOf(e) === status);
const oid = () => new mongoose.Types.ObjectId();
const WS = oid().toString();
const B = { workspaceId: WS, path: 'logs/app.log' };

(async () => {
  await check('service: single use, bound to workspace + path, opaque', async () => {
    const s = new DownloadTicketService();
    const t = s.issue(B, { userId: 'u1' });
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(t, s.issue(B, { userId: 'u1' }));
    assert.equal(s.consume(t, { ...B, path: 'other' }), null);
    assert.equal(s.consume(t, { ...B, workspaceId: oid().toString() }), null);
    assert.equal(s.peek(t, B), true);
    assert.deepEqual(s.consume(t, B), { userId: 'u1' });
    assert.equal(s.consume(t, B), null);
    assert.equal(s.peek(t, B), false);
    assert.equal(s.consume('nonsense', B), null);
    const k = s.issue(B, { userId: 'u2', apiKeyId: 'k1' });
    assert.deepEqual(s.consume(k, B), { userId: 'u2', apiKeyId: 'k1' });
  });

  await check('service: expires after the TTL (injected clock), live map is pruned', async () => {
    let now = 1000;
    const s = new DownloadTicketService(60_000, () => now);
    const t = s.issue(B, { userId: 'u1' });
    now += 59_999;
    assert.equal(s.peek(t, B), true);
    now += 2;
    assert.equal(s.peek(t, B), false);
    assert.equal(s.consume(t, B), null);
    assert.equal(s.tickets.size, 0);
  });

  const guardFor = (tickets) => new JwtAuthGuard(
    new Reflector(),
    { isAuthEnabled: () => true, findUserById: async () => ({ _id: 'u1', username: 'u', role: 'admin', active: true }) },
    { validate: async () => null },
    tickets,
  );
  const ctx = ({ ticketRoute = true, headers = {}, query = {}, params = { id: WS }, method = 'GET' }) => {
    function handler() {}
    class Ctrl {}
    if (ticketRoute) Reflect.defineMetadata(ACCEPTS_DOWNLOAD_TICKET_KEY, true, handler);
    const req = { headers, query, params, method };
    return { req, context: { getHandler: () => handler, getClass: () => Ctrl, switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }) } };
  };

  await check('guard: valid ticket passes without Bearer; used/expired/foreign/missing path -> 401', async () => {
    const s = new DownloadTicketService();
    const g = guardFor(s);
    const t = s.issue(B, { userId: 'u1' });
    assert.equal(await g.canActivate(ctx({ query: { path: B.path, ticket: t } }).context), true);
    // peek does not consume: the route still can
    assert.deepEqual(s.consume(t, B), { userId: 'u1' });
    await rejectsWith(() => g.canActivate(ctx({ query: { path: B.path, ticket: t } }).context), 401);
    const t2 = s.issue(B, { userId: 'u1' });
    await rejectsWith(() => g.canActivate(ctx({ query: { path: 'other', ticket: t2 } }).context), 401);
    await rejectsWith(() => g.canActivate(ctx({ query: { path: B.path, ticket: t2 }, params: { id: oid().toString() } }).context), 401);
    await rejectsWith(() => g.canActivate(ctx({ query: { ticket: t2 } }).context), 401);
    await rejectsWith(() => g.canActivate(ctx({ query: { path: B.path, ticket: 'x' } }).context), 401);
  });

  await check('guard: a route without the decorator, a POST, or a Bearer header never takes the ticket path', async () => {
    const s = new DownloadTicketService();
    const g = guardFor(s);
    const t = s.issue(B, { userId: 'u1' });
    const q = { path: B.path, ticket: t };
    // Not the ticket path: it falls to the normal authentication (no passport
    // strategy is registered here, so it errors) and never returns true.
    await assert.rejects(() => g.canActivate(ctx({ ticketRoute: false, query: q }).context));
    await assert.rejects(() => g.canActivate(ctx({ method: 'POST', query: q }).context));
    // Bearer present: normal auth decides (an invalid cv_ key -> 401), the ticket is not consulted
    await rejectsWith(() => g.canActivate(ctx({ headers: { authorization: 'Bearer cv_nope' }, query: q }).context), 401);
    assert.equal(s.peek(t, B), true);
  });

  // ---- controller
  const PROJECT = oid();
  const WRITER = { userId: 'u1', username: 'u', role: 'admin' };
  function setup({ readStreamImpl } = {}) {
    const calls = [];
    const client = {
      ensureDir: async () => undefined,
      readStream: async (...a) => {
        calls.push(a);
        if (readStreamImpl) return readStreamImpl(...a);
        return { stream: Readable.from([Buffer.from('xyz')]), size: 3 };
      },
    };
    const workspace = { _id: oid(), projectId: PROJECT, status: 'active' };
    const service = new WorkspacesService(
      { findById: () => ({ exec: async () => workspace }), updateOne: () => ({ exec: async () => undefined }) },
      { emit() {} },
    );
    const tickets = new DownloadTicketService();
    const resolved = [];
    const actors = { resolve: async (identity) => { resolved.push(identity); return WRITER; } };
    const ctrl = new WorkspaceFsController(
      service, client, { create: async () => undefined },
      { get: async () => ({ editorMaxBytes: 5, downloadMaxBytes: 777 }) }, tickets, actors,
    );
    return { ctrl, calls, tickets, resolved };
  }
  const fakeRes = () => Object.assign(new PassThrough(), { headers: {}, setHeader(k, v) { this.headers[k] = v; } });
  const asWriter = (fn) => RequestContext.run(WRITER, undefined, fn);

  await check('controller: download-ticket preflights, binds to the path, returns the raw URL', async () => {
    const { ctrl, calls, tickets } = setup();
    const out = await asWriter(() => ctrl.downloadTicket(WS, { path: 'logs/a b.log' }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2].maxBytes, 777);
    const u = new URL(out.url, 'http://x');
    assert.equal(u.pathname, `/api/workspaces/${WS}/fs/raw`);
    assert.equal(u.searchParams.get('path'), 'logs/a b.log');
    assert.equal(tickets.peek(u.searchParams.get('ticket'), { workspaceId: WS, path: 'logs/a b.log' }), true);
  });

  await check('controller: preflight error (413/404) surfaces and issues no ticket', async () => {
    const { HttpException } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/common'));
    const { ctrl, tickets } = setup({ readStreamImpl: async () => { throw new HttpException({ error: 'x', limit: 5 }, 413); } });
    await rejectsWith(() => asWriter(() => ctrl.downloadTicket(WS, { path: 'f' })), 413);
    assert.equal(tickets.tickets.size, 0);
  });

  await check('controller: raw?ticket streams as the resolved user, once; wrong path -> 401', async () => {
    const { ctrl, tickets, resolved } = setup();
    const t = tickets.issue({ workspaceId: WS, path: 'f.log' }, { userId: 'u1' });
    const res = fakeRes();
    // No actor in the request context: the ticket supplies it.
    await ctrl.raw(WS, { headers: {} }, res, 'f.log', t);
    assert.deepEqual(resolved, [{ userId: 'u1' }]);
    assert.match(res.headers['Content-Disposition'], /attachment; filename="f.log"/);
    await rejectsWith(() => ctrl.raw(WS, { headers: {} }, fakeRes(), 'f.log', t), 401);
    const t2 = tickets.issue({ workspaceId: WS, path: 'f.log' }, { userId: 'u1' });
    await rejectsWith(() => ctrl.raw(WS, { headers: {} }, fakeRes(), 'other.log', t2), 401);
  });

  await check('controller: the stream runs under the ticket user (gate sees the actor)', async () => {
    let seen;
    const { ctrl, tickets } = setup({ readStreamImpl: async () => { seen = RequestContext.getUser(); return { stream: Readable.from([Buffer.from('x')]), size: 1 }; } });
    const t = tickets.issue({ workspaceId: WS, path: 'f' }, { userId: 'u1' });
    await ctrl.raw(WS, { headers: {} }, fakeRes(), 'f', t);
    assert.equal(seen && seen.userId, 'u1');
  });

  await check('controller: a Bearer request ignores the ticket and needs the normal context', async () => {
    const { ctrl, tickets, resolved } = setup();
    const t = tickets.issue({ workspaceId: WS, path: 'f' }, { userId: 'u1' });
    await asWriter(() => ctrl.raw(WS, { headers: { authorization: 'Bearer x' } }, fakeRes(), 'f', t));
    assert.equal(resolved.length, 0);
    assert.equal(tickets.peek(t, { workspaceId: WS, path: 'f' }), true);
  });

  // ---- actor service
  await check('actor service: inactive user, revoked key, no write permission', async () => {
    const user = { _id: 'u1', username: 'u', role: 'admin', active: true };
    const mk = (u, key) => new DownloadActorService(
      { isAuthEnabled: () => true, findUserById: async () => u },
      { findActiveById: async () => key },
    );
    assert.equal((await mk(user, null).resolve({ userId: 'u1' })).userId, 'u1');
    await rejectsWith(() => mk({ ...user, active: false }, null).resolve({ userId: 'u1' }), 401);
    await rejectsWith(() => mk(null, null).resolve({ userId: 'u1' }), 401);
    await rejectsWith(() => mk(user, null).resolve({ userId: null }), 401);
    await rejectsWith(() => mk(user, null).resolve({ userId: 'u1', apiKeyId: 'k' }), 401);
    const key = { _id: 'k', userId: 'u1', allowedTools: null };
    assert.equal((await mk(user, key).resolve({ userId: 'u1', apiKeyId: 'k' })).apiKeyId, 'k');
    await rejectsWith(() => mk(user, { ...key, userId: 'someone-else' }).resolve({ userId: 'u1', apiKeyId: 'k' }), 401);
    await rejectsWith(() => mk(user, { ...key, allowedTools: ['x'] }).resolve({ userId: 'u1', apiKeyId: 'k' }), 401);
    const readOnly = { ...user, permissions: ['project:read'], permissionsRestricted: true };
    await rejectsWith(() => mk(readOnly, null).resolve({ userId: 'u1' }), 403);
    const off = new DownloadActorService({ isAuthEnabled: () => false }, {});
    assert.equal(await off.resolve({ userId: null }), undefined);
  });

  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
})();
