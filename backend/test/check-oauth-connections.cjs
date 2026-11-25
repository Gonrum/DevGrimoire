#!/usr/bin/env node
/*
 * MCP OAuth connections (Task 4): "connected apps" list and revocation,
 * account events revoking every connection, provisional connections for
 * approved-but-unredeemed codes, access listings marking OAuth entries,
 * the /api/api-keys routes refusing OAuth keys, the audit trail, and the
 * public /api/oauth/info endpoint.
 *
 * Loads from dist/; run `npm run build` first. No database: in-memory model
 * fakes as in check-oauth-core.cjs, time from an injected clock.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function load(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.\n${err.message}`);
    process.exit(2);
  }
}
const { OAuthService, OAUTH_CONNECTION_REVOKED } = load('oauth/oauth.service.js');
const { OAuthController } = load('oauth/oauth.controller.js');
const { ApiKeysService } = load('api-keys/api-keys.service.js');
const { AuthService } = load('auth/auth.service.js');
const { RequestContext } = load('common/request-context.js');
const { ROLES_KEY } = load('auth/decorators/roles.decorator.js');
const { IS_PUBLIC_KEY } = load('auth/decorators/public.decorator.js');
const { PermissionGateGuard } = load('auth/guards/permission-gate.guard.js');
const { Reflector } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/core'));
const backendModules = path.resolve(__dirname, '..', 'node_modules');
const { Types } = require(path.join(backendModules, 'mongoose'));
const bcrypt = require(path.join(backendModules, 'bcryptjs'));
require(path.join(backendModules, 'reflect-metadata'));

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`ok  ${label}`); }
  catch (err) { failures += 1; console.error(`FAIL ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
async function status(fn) {
  try { await fn(); return 200; } catch (err) {
    return typeof err.getStatus === 'function' ? err.getStatus() : `non-http:${err.message}`;
  }
}

// ---------------------------------------------------------------- fake models
const isOid = (v) => v instanceof Types.ObjectId;
const norm = (v) => (isOid(v) ? String(v) : v instanceof Date ? v.getTime() : v);
const same = (a, b) => {
  if (Array.isArray(a)) return a.some((x) => same(x, b));
  return norm(a) === norm(b);
};
function matchValue(actual, cond) {
  if (cond !== null && typeof cond === 'object' && !isOid(cond) && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case '$exists': return v ? actual !== undefined : actual === undefined;
        case '$ne': return !same(actual, v);
        case '$in': return v.some((x) => same(actual, x));
        case '$gt': return actual !== undefined && actual !== null && norm(actual) > norm(v);
        case '$lte': return actual !== undefined && norm(actual) <= norm(v);
        default: throw new Error(`fake model: unsupported operator ${op}`);
      }
    });
  }
  if (cond === undefined) throw new Error('fake model: undefined in filter (project rule!)');
  if (cond === null) return actual === undefined || actual === null;
  return same(actual, cond);
}
function matches(doc, filter) {
  return Object.entries(filter || {}).every(([k, c]) => {
    if (k === '$or') return c.some((f) => matches(doc, f));
    if (k === '$and') return c.every((f) => matches(doc, f));
    return matchValue(doc[k], c);
  });
}
function applyUpdate(doc, update) {
  const plain = Object.keys(update).some((k) => !k.startsWith('$'));
  if (plain) throw new Error('fake model: plain update object, use $set');
  Object.assign(doc, update.$set || {});
  for (const k of Object.keys(update.$unset || {})) delete doc[k];
}
function query(result) {
  const q = {
    exec: async () => (typeof result === 'function' ? result() : result),
    lean() { return q; }, select() { return q; }, sort() { return q; },
    then(res, rej) { return q.exec().then(res, rej); },
  };
  return q;
}
function makeModel(name, defaults = {}) {
  const docs = [];
  const clone = (d) => (d ? { ...d } : d);
  const model = {
    name, docs, pipelines: [],
    async create(input) {
      const doc = { _id: new Types.ObjectId(), createdAt: new Date(), ...defaults, ...input };
      docs.push(doc);
      return { ...doc, toObject: () => clone(doc) };
    },
    findOne: (f) => query(() => clone(docs.find((d) => matches(d, f)) ?? null)),
    find: (f) => query(() => docs.filter((d) => matches(d, f)).map(clone)),
    findOneAndUpdate: (f, u, opts = {}) => query(() => {
      const d = docs.find((x) => matches(x, f));
      if (!d) return null;
      const before = clone(d);
      applyUpdate(d, u);
      return opts.new || opts.returnDocument === 'after' ? clone(d) : before;
    }),
    findOneAndDelete: (f) => query(() => {
      const i = docs.findIndex((x) => matches(x, f));
      if (i < 0) return null;
      return docs.splice(i, 1)[0];
    }),
    updateOne: (f, u) => query(() => {
      const d = docs.find((x) => matches(x, f));
      if (d) applyUpdate(d, u);
      return { matchedCount: d ? 1 : 0, modifiedCount: d ? 1 : 0 };
    }),
    deleteOne: (f) => query(() => {
      const i = docs.findIndex((x) => matches(x, f));
      if (i >= 0) docs.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    }),
    deleteMany: (f) => query(() => {
      if (!f || Object.keys(f).length === 0) throw new Error('fake model: deleteMany({}) refused');
      let n = 0;
      for (let i = docs.length - 1; i >= 0; i--) if (matches(docs[i], f)) { docs.splice(i, 1); n++; }
      return { deletedCount: n };
    }),
    // Evaluates the stages the access listings use: $match, $sort (ignored),
    // $lookup (owner username from the `users` list), $addFields with
    // $ifNull / $arrayElemAt, $project exclusions.
    aggregate: (pipeline) => {
      model.pipelines.push(pipeline);
      return query(() => {
        let rows = docs.map(clone);
        for (const stage of pipeline) {
          if (stage.$match) rows = rows.filter((r) => matches(r, stage.$match));
          else if (stage.$sort) continue;
          else if (stage.$lookup) rows = rows.map((r) => ({ ...r, owner: (model.users || []).filter((u) => same(u._id, r.userId)) }));
          else if (stage.$addFields) {
            rows = rows.map((r) => {
              const out = { ...r };
              for (const [k, expr] of Object.entries(stage.$addFields)) {
                if (expr.$ifNull) {
                  const [field, dflt] = expr.$ifNull;
                  const v = r[field.slice(1)];
                  out[k] = v === undefined || v === null ? dflt : v;
                } else if (expr.$arrayElemAt) {
                  const [ref] = expr.$arrayElemAt;
                  const [arr, prop] = ref.slice(1).split('.');
                  out[k] = (r[arr] || [])[0]?.[prop];
                } else throw new Error(`fake aggregate: unsupported expression for ${k}`);
              }
              return out;
            });
          } else if (stage.$project) {
            rows = rows.map((r) => {
              const out = { ...r };
              for (const [k, v] of Object.entries(stage.$project)) if (v === 0) delete out[k];
              return out;
            });
          } else throw new Error(`fake aggregate: unsupported stage ${Object.keys(stage)[0]}`);
        }
        return rows;
      });
    },
  };
  return model;
}

// ---------------------------------------------------------------- fixtures
const RESOURCE = 'https://dg.example.test/mcp';
const USER = new Types.ObjectId().toString();
const OTHER_USER = new Types.ObjectId().toString();
const P1 = new Types.ObjectId();
const C1 = new Types.ObjectId();
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

function setup({ resource = RESOURCE } = {}) {
  const clock = { t: Date.now() };
  const models = {
    client: makeModel('oauthclients'), request: makeModel('oauthauthrequests'),
    code: makeModel('oauthcodes'), token: makeModel('oauthtokens'),
    apiKey: makeModel('apikeys', { active: true, kind: 'standard' }), link: makeModel('customerprojectlinks'),
  };
  models.apiKey.users = [
    { _id: new Types.ObjectId(USER), username: 'alice' },
    { _id: new Types.ObjectId(OTHER_USER), username: 'bob' },
  ];
  models.link.docs.push({ _id: new Types.ObjectId(), customerId: C1, projectId: P1, status: 'active' });
  const audit = { records: [], record: async (r) => { audit.records.push(r); } };
  const apiKeys = new ApiKeysService(models.apiKey, audit);
  const events = { emitted: [], emit(name, payload) { events.emitted.push({ name, payload }); return true; } };
  const svc = new OAuthService(
    models.client, models.request, models.code, models.token, models.apiKey, models.link,
    apiKeys, events, audit, { resource, now: () => clock.t },
  );
  return { svc, apiKeys, models, events, audit, clock, advance: (ms) => { clock.t += ms; } };
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}
async function approvedCode(env, { userId = USER, projectIds } = {}) {
  const client = await env.svc.registerClient({ client_name: 'Claude', redirect_uris: [CLAUDE_CB] });
  const { verifier, challenge } = pkce();
  const requestId = await env.svc.createAuthRequest(client, { codeChallenge: challenge, redirectUri: CLAUDE_CB, state: 's', scopes: [], resource: new URL(RESOURCE) });
  const { redirectUrl } = await env.svc.decide(requestId, userId, { approve: true, projectIds });
  return { client, verifier, code: new URL(redirectUrl).searchParams.get('code') };
}
async function connected(env, opts) {
  const a = await approvedCode(env, opts);
  const t = await env.svc.exchangeCode(a.client.client_id, a.code, a.verifier, CLAUDE_CB, new URL(RESOURCE));
  const info = await env.svc.verifyAccessToken(t.access_token);
  return { ...a, t, apiKeyId: info.apiKeyId };
}
const keyById = (env, id) => env.models.apiKey.docs.find((k) => String(k._id) === String(id));
const jwtReq = (userId = USER, over = {}) => ({ user: { userId, username: 'u', role: 'user', projectScopeMode: 'all', allowedProjectIds: [], ...over } });
const revokedEvents = (env) => env.events.emitted.filter((e) => e.name === OAUTH_CONNECTION_REVOKED).map((e) => e.payload);

(async () => {
  // ------------------------------------------------------------ provisional connections
  await check('approval creates a provisional connection (10 min, pending), redemption makes it 1 year', async () => {
    const env = setup();
    const a = await approvedCode(env);
    const key = env.models.apiKey.docs[0];
    assert.equal(key.oauthPending, true);
    assert.equal(key.oauthClientName, 'Claude');
    const minutes = (key.expiresAt.getTime() - env.clock.t) / MIN;
    assert.ok(minutes > 9 && minutes <= 10, `provisional expiry ${minutes} min`);
    assert.equal((await env.svc.listConnections(USER)).length, 0, 'pending connection must not be listed');
    await env.svc.exchangeCode(a.client.client_id, a.code, a.verifier, CLAUDE_CB, new URL(RESOURCE));
    const after = env.models.apiKey.docs[0];
    assert.equal(after.oauthPending, undefined);
    const days = (after.expiresAt.getTime() - env.clock.t) / DAY;
    assert.ok(days > 364 && days < 366, `expiry ${days} days`);
    assert.equal((await env.svc.listConnections(USER)).length, 1);
  });

  await check('an unredeemed approval expires after 10 minutes (code would be dead anyway)', async () => {
    const env = setup();
    await approvedCode(env);
    env.advance(11 * MIN);
    const key = env.models.apiKey.docs[0];
    assert.ok(key.expiresAt.getTime() <= env.clock.t);
  });

  // ------------------------------------------------------------ listing
  await check('listConnections: only own, active, redeemed oauth connections, newest first', async () => {
    const env = setup();
    const mine = await connected(env, { projectIds: [String(P1)] });
    const revoked = await connected(env);
    await env.svc.revokeConnection(revoked.apiKeyId, 'user');
    await connected(env, { userId: OTHER_USER });
    await approvedCode(env); // pending
    await env.apiKeys.generate(USER, 'cli');
    const list = await env.svc.listConnections(USER);
    assert.equal(list.length, 1);
    const c = list[0];
    assert.equal(c.id, mine.apiKeyId);
    assert.equal(c.clientName, 'Claude');
    assert.equal(c.clientId, mine.client.client_id);
    assert.equal(c.projectScopeMode, 'allowlist');
    assert.deepEqual(c.allowedProjectIds, [String(P1)]);
    assert.ok(c.createdAt instanceof Date);
    assert.ok(c.lastUsedAt instanceof Date, 'verifyAccessToken marks the connection as used');
    assert.equal(JSON.stringify(list).includes('keyHash'), false);
    assert.deepEqual(await env.svc.listConnections('garbage'), []);
  });

  await check('verifyAccessToken updates lastUsedAt at most once a minute', async () => {
    const env = setup();
    const c = await connected(env);
    const first = keyById(env, c.apiKeyId).lastUsedAt.getTime();
    env.advance(30 * 1000);
    await env.svc.verifyAccessToken(c.t.access_token);
    assert.equal(keyById(env, c.apiKeyId).lastUsedAt.getTime(), first);
    env.advance(31 * 1000);
    await env.svc.verifyAccessToken(c.t.access_token);
    assert.equal(keyById(env, c.apiKeyId).lastUsedAt.getTime(), env.clock.t);
  });

  // ------------------------------------------------------------ controller
  await check('GET /oauth/connections lists the signed-in user\'s connections; API keys 403', async () => {
    const env = setup();
    await connected(env);
    const ctl = new OAuthController(env.svc);
    const list = await ctl.listConnections(jwtReq());
    assert.equal(list.length, 1);
    assert.equal(await status(() => ctl.listConnections(jwtReq(USER, { apiKeyId: 'k' }))), 403);
    assert.equal(await status(() => ctl.listConnections({ ...jwtReq(), apiKey: { _id: 'k' } })), 403);
  });

  await check('DELETE /oauth/connections/:id of another user → 404, connection stays', async () => {
    const env = setup();
    const theirs = await connected(env, { userId: OTHER_USER });
    const ctl = new OAuthController(env.svc);
    assert.equal(await status(() => ctl.revokeConnection(theirs.apiKeyId, jwtReq())), 404);
    assert.equal(keyById(env, theirs.apiKeyId).active, true);
    assert.equal(await status(() => ctl.revokeConnection('garbage', jwtReq())), 404);
    assert.deepEqual(revokedEvents(env), []);
  });

  await check('DELETE own connection → revokeConnection (key inactive, tokens gone, event reason user)', async () => {
    const env = setup();
    const mine = await connected(env);
    const ctl = new OAuthController(env.svc);
    const res = await ctl.revokeConnection(mine.apiKeyId, jwtReq());
    assert.deepEqual(res, { revoked: true });
    assert.equal(keyById(env, mine.apiKeyId).active, false);
    assert.equal(env.models.token.docs.length, 0);
    assert.deepEqual(revokedEvents(env), [{ apiKeyId: mine.apiKeyId, reason: 'user' }]);
    assert.equal(await status(() => ctl.revokeConnection(mine.apiKeyId, jwtReq())), 404, 'already revoked');
    // Revoking must not need project:write (entry gate left to the service).
    assert.equal(Reflect.getMetadata('permissionGate', OAuthController.prototype.revokeConnection), 'service');
  });

  await check('admin route revokes any connection with reason admin; it is admin-only', async () => {
    const env = setup();
    const theirs = await connected(env, { userId: OTHER_USER });
    const ctl = new OAuthController(env.svc);
    const roles = Reflect.getMetadata(ROLES_KEY, OAuthController.prototype.adminRevokeConnection);
    assert.deepEqual(roles, ['admin']);
    await ctl.adminRevokeConnection(theirs.apiKeyId, jwtReq(USER, { role: 'admin' }));
    assert.equal(keyById(env, theirs.apiKeyId).active, false);
    assert.deepEqual(revokedEvents(env), [{ apiKeyId: theirs.apiKeyId, reason: 'admin' }]);
    const std = await env.apiKeys.generate(USER, 'cli');
    assert.equal(await status(() => ctl.adminRevokeConnection(String(std.apiKey._id), jwtReq(USER, { role: 'admin' }))), 404, 'standard keys are not connections');
    assert.equal(await status(() => ctl.adminRevokeConnection(theirs.apiKeyId, jwtReq(USER, { role: 'admin', apiKeyId: 'k' }))), 403);
  });

  await check('GET /oauth/info is public: { enabled:false } or { enabled:true, mcpUrl }', async () => {
    assert.equal(Reflect.getMetadata(IS_PUBLIC_KEY, OAuthController.prototype.info), true);
    const on = new OAuthController(setup().svc);
    assert.deepEqual(on.info(), { enabled: true, mcpUrl: RESOURCE });
    const off = new OAuthController(setup({ resource: null }).svc);
    assert.deepEqual(off.info(), { enabled: false });
  });

  await check('entry gate: user without project:write may decide consent and revoke (own + admin)', async () => {
    const readOnly = { userId: USER, username: 'u', role: 'user', permissions: ['project:read'], projectScopeMode: 'all', allowedProjectIds: [] };
    const guard = new PermissionGateGuard(new Reflector());
    const run = (handler, method) => guard.canActivate({
      getType: () => 'http', getHandler: () => handler, getClass: () => OAuthController,
      switchToHttp: () => ({ getRequest: () => ({ method, user: readOnly }) }),
    });
    assert.equal(run(OAuthController.prototype.decide, 'POST'), true);
    assert.equal(run(OAuthController.prototype.revokeConnection, 'DELETE'), true);
    assert.equal(run(OAuthController.prototype.adminRevokeConnection, 'DELETE'), true);
    // Control: an ungated write handler is still refused for this actor.
    function plainWrite() {}
    assert.throws(() => run(plainWrite, 'POST'), (e) => e.getStatus() === 403);
  });

  await check('exchangeCode: connection revoked before activation → invalid_grant, no tokens', async () => {
    const env = setup();
    const a = await approvedCode(env);
    const realActivate = env.models.apiKey.findOneAndUpdate;
    // Simulate a revoke landing between the active check and the activation.
    env.models.apiKey.findOneAndUpdate = (f, u, o) => {
      env.models.apiKey.docs[0].active = false;
      env.models.apiKey.findOneAndUpdate = realActivate;
      return realActivate(f, u, o);
    };
    await assert.rejects(
      () => env.svc.exchangeCode(a.client.client_id, a.code, a.verifier, CLAUDE_CB, new URL(RESOURCE)),
      (e) => e.errorCode === 'invalid_grant',
    );
    assert.equal(env.models.token.docs.length, 0);
  });

  // ------------------------------------------------------------ account events
  function authWith(oauthCalls, user) {
    const auth = Object.create(AuthService.prototype);
    auth.logger = { warn() {}, log() {}, error() {} };
    auth.auditLog = { record: async () => {} };
    auth.oauth = { revokeAllForUser: async (id) => { oauthCalls.push(id); return 1; } };
    auth.refreshTokenModel = { deleteMany: () => ({ exec: async () => ({ deletedCount: 0 }) }) };
    auth.userModel = {
      findById: () => ({ exec: async () => user }),
      findByIdAndUpdate: () => ({ select: () => ({ exec: async () => ({ _id: USER, username: 'alice' }) }) }),
      findByIdAndDelete: () => ({ exec: async () => ({ _id: USER, username: 'alice', role: 'user' }) }),
    };
    return auth;
  }

  await check('changePassword revokes all OAuth connections of the user (not on a wrong old password)', async () => {
    const calls = [];
    const user = { _id: USER, passwordHash: await bcrypt.hash('old-pass', 4), save: async () => {} };
    const auth = authWith(calls, user);
    await assert.rejects(() => auth.changePassword(USER, 'wrong', 'new-pass'));
    assert.deepEqual(calls, []);
    await auth.changePassword(USER, 'old-pass', 'new-pass');
    assert.deepEqual(calls, [USER]);
  });

  await check('updateUser revokes on deactivation only', async () => {
    const calls = [];
    const auth = authWith(calls, null);
    await auth.updateUser(USER, { email: 'x@example.test' });
    await auth.updateUser(USER, { active: true });
    assert.deepEqual(calls, []);
    await auth.updateUser(USER, { active: false });
    assert.deepEqual(calls, [USER]);
  });

  await check('deleteUser revokes all OAuth connections of the user', async () => {
    const calls = [];
    const auth = authWith(calls, null);
    assert.equal(await auth.deleteUser(USER), true);
    assert.deepEqual(calls, [USER]);
  });

  await check('deleteUser records the audit row even if revoking the connections fails', async () => {
    const auth = authWith([], null);
    const audited = [];
    auth.auditLog = { record: async (r) => { audited.push(r.action); } };
    auth.oauth = { revokeAllForUser: async () => { throw new Error('db down'); } };
    await assert.rejects(() => auth.deleteUser(USER), /db down/);
    assert.deepEqual(audited, ['user.deleted']);
  });

  await check('revokeAllForUser also ends pending connections, reason account', async () => {
    const env = setup();
    const c = await connected(env);
    await approvedCode(env);
    assert.equal(await env.svc.revokeAllForUser(USER), 2);
    assert.equal(env.models.apiKey.docs.filter((k) => k.active).length, 0);
    assert.ok(revokedEvents(env).every((e) => e.reason === 'account'));
    assert.ok(revokedEvents(env).some((e) => e.apiKeyId === c.apiKeyId));
  });

  // ------------------------------------------------------------ access listings
  await check('findAllWithOwners: OAuth entries marked (kind, client name), revoked/pending ones hidden', async () => {
    const env = setup();
    const live = await connected(env);
    const gone = await connected(env);
    await env.svc.revokeConnection(gone.apiKeyId, 'user');
    await approvedCode(env); // pending
    const old = await connected(env);
    keyById(env, old.apiKeyId).expiresAt = new Date(Date.now() - 1000); // expired
    await env.apiKeys.generate(USER, 'cli');
    delete env.models.apiKey.docs.find((k) => k.name === 'cli').kind; // legacy row without the field
    const rows = await env.apiKeys.findAllWithOwners();
    assert.equal(rows.length, 2);
    const oauth = rows.find((r) => r.kind === 'oauth');
    assert.equal(String(oauth._id), live.apiKeyId);
    assert.equal(oauth.oauthClientName, 'Claude');
    assert.equal(oauth.ownerUsername, 'alice');
    assert.equal(oauth.keyHash, undefined);
    assert.equal(rows.find((r) => r.name === 'cli').kind, 'standard');
  });

  await check('findByProjectAccess: OAuth marked; revoked, pending and expired keys do not count as access', async () => {
    const env = setup();
    const scoped = await connected(env, { projectIds: [String(P1)] });
    const gone = await connected(env);
    await env.svc.revokeConnection(gone.apiKeyId, 'user');
    await approvedCode(env); // pending, all projects
    const expired = await env.apiKeys.generate(USER, 'old', new Date(Date.now() - DAY));
    const live = await env.apiKeys.generate(USER, 'cli');
    const rows = await env.apiKeys.findByProjectAccess(String(P1));
    const ids = rows.map((r) => String(r._id)).sort();
    assert.deepEqual(ids, [scoped.apiKeyId, String(live.apiKey._id)].sort());
    assert.ok(!ids.includes(String(expired.apiKey._id)));
    const oauth = rows.find((r) => r.kind === 'oauth');
    assert.equal(oauth.oauthClientName, 'Claude');
  });

  // ------------------------------------------------------------ /api/api-keys guard
  await check('/api/api-keys revoke and update refuse OAuth connections (400), standard keys still work', async () => {
    const env = setup();
    const c = await connected(env);
    assert.equal(await status(() => env.apiKeys.revoke(c.apiKeyId, USER)), 400);
    assert.equal(await status(() => env.apiKeys.update(c.apiKeyId, USER, { name: 'x', projectScopeMode: 'all' })), 400);
    const key = keyById(env, c.apiKeyId);
    assert.equal(key.active, true);
    assert.equal(key.name, 'OAuth: Claude');
    const std = await env.apiKeys.generate(USER, 'cli');
    await env.apiKeys.update(String(std.apiKey._id), USER, { name: 'cli2' });
    assert.equal(keyById(env, std.apiKey._id).name, 'cli2');
    await env.apiKeys.revoke(String(std.apiKey._id), USER);
    assert.equal(keyById(env, std.apiKey._id), undefined);
    assert.equal(await status(() => env.apiKeys.revoke(String(new Types.ObjectId()), USER)), 404);
  });

  // ------------------------------------------------------------ audit
  await check('audit: approval, denial, token issuance, refresh misuse, revocation — never a secret', async () => {
    const env = setup();
    const c = await RequestContext.run({ userId: USER, username: 'alice', role: 'user' }, undefined, () => connected(env));
    // denial
    const client = await env.svc.registerClient({ client_name: 'Evil', redirect_uris: [CLAUDE_CB] });
    const { challenge } = pkce();
    const req = await env.svc.createAuthRequest(client, { codeChallenge: challenge, redirectUri: CLAUDE_CB, scopes: [] });
    await env.svc.decide(req, USER, { approve: false });
    // refresh, then misuse of the old refresh token after the grace window
    const t2 = await env.svc.exchangeRefresh(c.client.client_id, c.t.refresh_token);
    env.advance(11 * 1000);
    await assert.rejects(() => env.svc.exchangeRefresh(c.client.client_id, c.t.refresh_token));

    const actions = env.audit.records.map((r) => r.action);
    assert.ok(actions.includes('oauth.consent.approved'), actions.join());
    assert.ok(actions.includes('oauth.consent.denied'), actions.join());
    assert.equal(actions.filter((a) => a === 'oauth.token.issued').length, 1, 'only the code exchange is audited, not the refresh');
    assert.ok(actions.includes('oauth.refresh.reused'));
    const revoked = env.audit.records.find((r) => r.action === 'oauth.connection.revoked');
    assert.equal(revoked.meta.reason, 'refresh_replay');
    assert.equal(revoked.entityId, c.apiKeyId);
    const approved = env.audit.records.find((r) => r.action === 'oauth.consent.approved');
    assert.equal(approved.meta.redirectHost, 'claude.ai');
    assert.equal(approved.actor.userId, USER);
    const issued = env.audit.records.filter((r) => r.action === 'oauth.token.issued');
    assert.deepEqual(issued.map((r) => r.meta.grant), ['authorization_code']);
    assert.ok(!issued.some((r) => r.meta.grant === 'refresh_token'));
    assert.equal(issued[0].actor.apiKeyId, c.apiKeyId);
    const dump = JSON.stringify(env.audit.records);
    for (const secret of [c.code, c.t.access_token, c.t.refresh_token, t2.access_token, t2.refresh_token, req]) {
      assert.ok(!dump.includes(secret), `secret in audit trail: ${secret.slice(0, 8)}…`);
    }
  });

  await check('audit: revocation by user and by account event carry the reason', async () => {
    const env = setup();
    const a = await connected(env);
    const b = await connected(env);
    await env.svc.revokeOwnConnection(USER, a.apiKeyId);
    await env.svc.revokeAllForUser(USER);
    const rows = env.audit.records.filter((r) => r.action === 'oauth.connection.revoked');
    assert.deepEqual(rows.map((r) => [r.entityId, r.meta.reason]), [[a.apiKeyId, 'user'], [b.apiKeyId, 'account']]);
    assert.equal(rows[0].meta.ownerUserId, USER);
  });

  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures ? 1 : 0);
})();
