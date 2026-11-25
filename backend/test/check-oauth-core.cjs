#!/usr/bin/env node
/*
 * MCP OAuth core (Task 1): client registration, authorization requests,
 * one-time codes with PKCE, rotating refresh tokens, revocation, and the
 * ApiKey `kind: 'oauth'` connection record behind every grant.
 *
 * Loads from dist/; run `npm run build` first. No database, no network:
 * the Mongoose models are in-memory fakes that understand the small filter
 * and update vocabulary the services use. Time comes from an injected clock.
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
const { ApiKeysService } = load('api-keys/api-keys.service.js');
const { RequestContext } = load('common/request-context.js');
const { Types } = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`ok  ${label}`); }
  catch (err) { failures += 1; console.error(`FAIL ${label}\n    ${err && err.stack ? err.stack : err}`); }
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
        case '$nin': return !v.some((x) => same(actual, x));
        case '$gt': return actual !== undefined && norm(actual) > norm(v);
        case '$lte': return actual !== undefined && norm(actual) <= norm(v);
        default: throw new Error(`fake model: unsupported operator ${op}`);
      }
    });
  }
  if (cond === undefined) throw new Error('fake model: undefined in filter (project rule!)');
  if (cond === null) return actual === undefined || actual === null;
  return same(actual, cond);
}
const matches = (doc, filter) => Object.entries(filter || {}).every(([k, c]) => matchValue(doc[k], c));
function applyUpdate(doc, update) {
  const set = update.$set || {}; const unset = update.$unset || {};
  const plain = Object.keys(update).some((k) => !k.startsWith('$'));
  if (plain) throw new Error('fake model: plain update object, use $set');
  Object.assign(doc, set);
  for (const k of Object.keys(unset)) delete doc[k];
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
  return {
    name, docs,
    async create(input) {
      const doc = { _id: new Types.ObjectId(), createdAt: new Date(), ...defaults, ...input };
      docs.push(doc);
      return { ...doc, toObject: () => clone(doc) };
    },
    findOne: (f) => query(() => clone(docs.find((d) => matches(d, f)) ?? null)),
    findById: (id) => query(() => clone(docs.find((d) => String(d._id) === String(id)) ?? null)),
    find: (f) => query(() => docs.filter((d) => matches(d, f)).map(clone)),
    findOneAndUpdate: (f, u, opts = {}) => query(() => {
      const d = docs.find((x) => matches(x, f));
      if (!d) return null;
      const before = clone(d);
      applyUpdate(d, u);
      return opts.new || opts.returnDocument === 'after' ? clone(d) : before;
    }),
    updateOne: (f, u) => query(() => {
      const d = docs.find((x) => matches(x, f));
      if (d) applyUpdate(d, u);
      return { matchedCount: d ? 1 : 0, modifiedCount: d ? 1 : 0 };
    }),
    updateMany: (f, u) => query(() => {
      const hit = docs.filter((x) => matches(x, f));
      hit.forEach((d) => applyUpdate(d, u));
      return { matchedCount: hit.length, modifiedCount: hit.length };
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
  };
}

// ---------------------------------------------------------------- fixtures
const RESOURCE = 'https://dg.example.test/mcp';
const USER = new Types.ObjectId().toString();
const OTHER_USER = new Types.ObjectId().toString();
const P1 = new Types.ObjectId();
const P2 = new Types.ObjectId();
const C1 = new Types.ObjectId();
const C2 = new Types.ObjectId();
const C3 = new Types.ObjectId();

function setup() {
  const clock = { t: Date.UTC(2026, 10, 25, 12, 0, 0) };
  const models = {
    client: makeModel('oauthclients'), request: makeModel('oauthauthrequests'),
    code: makeModel('oauthcodes'), token: makeModel('oauthtokens'),
    apiKey: makeModel('apikeys', { active: true }) /* schema default */, link: makeModel('customerprojectlinks'),
  };
  models.link.docs.push(
    { _id: new Types.ObjectId(), customerId: C1, projectId: P1, status: 'active' },
    { _id: new Types.ObjectId(), customerId: C2, projectId: P1, status: 'paused' },
    { _id: new Types.ObjectId(), customerId: C3, projectId: P1, status: 'archived' },
    { _id: new Types.ObjectId(), customerId: C3, projectId: P2, status: 'active' },
  );
  const audit = { records: [], record: async (r) => { audit.records.push(r); } };
  const apiKeys = new ApiKeysService(models.apiKey, audit);
  const events = { emitted: [], emit(name, payload) { events.emitted.push({ name, payload }); return true; } };
  const svc = new OAuthService(
    models.client, models.request, models.code, models.token, models.apiKey, models.link,
    apiKeys, events, audit, { resource: RESOURCE, now: () => clock.t },
  );
  const advance = (ms) => { clock.t += ms; };
  return { svc, apiKeys, models, events, audit, clock, advance };
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const LOCAL_CB = 'http://localhost:33418/callback';

async function expectOAuthError(promise, code) {
  let err;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, `expected ${code}, got success`);
  assert.equal(err.errorCode, code, `expected ${code}, got ${err.errorCode ?? err.constructor.name}: ${err.message}`);
  return err;
}
async function expectThrow(promise) {
  let err;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, 'expected an error, got success');
  return err;
}

async function register(svc, extra = {}) {
  return svc.registerClient({ client_name: 'Claude', redirect_uris: [CLAUDE_CB, LOCAL_CB], token_endpoint_auth_method: 'none', ...extra });
}
/** register → authorize → approve; returns everything a test needs. */
async function approvedCode(env, { projectIds, redirectUri = CLAUDE_CB, state = 'st-123' } = {}) {
  const client = await register(env.svc);
  const { verifier, challenge } = pkce();
  const requestId = await env.svc.createAuthRequest(client, { codeChallenge: challenge, redirectUri, state, scopes: [], resource: new URL(RESOURCE) });
  const { redirectUrl } = await env.svc.decide(requestId, USER, { approve: true, projectIds });
  const url = new URL(redirectUrl);
  return { client, verifier, challenge, requestId, redirectUrl, code: url.searchParams.get('code'), url };
}
async function tokens(env, opts) {
  const a = await approvedCode(env, opts);
  const t = await env.svc.exchangeCode(a.client.client_id, a.code, a.verifier, opts?.redirectUri ?? CLAUDE_CB, new URL(RESOURCE));
  return { ...a, t };
}
const allStored = (env) => JSON.stringify(Object.values(env.models).flatMap((m) => m.docs));

(async () => {
  // ------------------------------------------------------------ registration
  await check('registerClient: foreign http redirect rejected', async () => {
    const { svc } = setup();
    await expectOAuthError(svc.registerClient({ client_name: 'x', redirect_uris: ['http://evil.example/cb'] }), 'invalid_client_metadata');
  });

  await check('registerClient: https + loopback accepted, public client without secret', async () => {
    const { svc, models } = setup();
    const c = await svc.registerClient({
      client_name: 'Claude', redirect_uris: [CLAUDE_CB, LOCAL_CB, 'http://127.0.0.1:9/cb', 'http://[::1]:7/cb'],
      token_endpoint_auth_method: 'client_secret_post', client_secret: 'sneaky', client_id: 'chosen-by-client',
    });
    assert.ok(c.client_id && c.client_id !== 'chosen-by-client');
    assert.deepEqual(c.redirect_uris, [CLAUDE_CB, LOCAL_CB, 'http://127.0.0.1:9/cb', 'http://[::1]:7/cb']);
    assert.equal(c.token_endpoint_auth_method, 'none');
    assert.equal(c.client_secret, undefined);
    assert.ok(!allStored({ models }).includes('sneaky'));
    const again = await svc.getClient(c.client_id);
    assert.equal(again.client_id, c.client_id);
    assert.equal(again.client_name, 'Claude');
  });

  await check('registerClient: name limits, uri count/length, fragments, userinfo, control chars', async () => {
    const { svc } = setup();
    await expectOAuthError(svc.registerClient({ client_name: 'a'.repeat(101), redirect_uris: [CLAUDE_CB] }), 'invalid_client_metadata');
    await svc.registerClient({ client_name: 'a'.repeat(100), redirect_uris: [CLAUDE_CB] });
    await expectOAuthError(svc.registerClient({ client_name: 'x', redirect_uris: [] }), 'invalid_client_metadata');
    await expectOAuthError(svc.registerClient({ client_name: 'x', redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`) }), 'invalid_client_metadata');
    await expectOAuthError(svc.registerClient({ client_name: 'x', redirect_uris: [`https://a.example/${'p'.repeat(490)}`] }), 'invalid_client_metadata');
    await expectOAuthError(svc.registerClient({ client_name: 'x', redirect_uris: ['https://a.example/cb#frag'] }), 'invalid_client_metadata');
    await expectOAuthError(svc.registerClient({ client_name: 'x', redirect_uris: ['https://user:pw@a.example/cb'] }), 'invalid_client_metadata');
    await expectOAuthError(svc.registerClient({ client_name: 'Clau‮de', redirect_uris: [CLAUDE_CB] }), 'invalid_client_metadata');
    await expectOAuthError(svc.registerClient({ client_name: 'x', redirect_uris: ['javascript:alert(1)'] }), 'invalid_client_metadata');
    await expectOAuthError(svc.registerClient({ client_name: 'x', redirect_uris: ['http://localhost.evil.example/cb'] }), 'invalid_client_metadata');
  });

  await check('getClient: unused registration expires after 24 h, approved one stays', async () => {
    const env = setup();
    const unused = await register(env.svc);
    const { client: used } = await approvedCode(env);
    env.advance(24 * 3600 * 1000 + 1000);
    assert.equal(await env.svc.getClient(unused.client_id), undefined);
    assert.equal((await env.svc.getClient(used.client_id)).client_id, used.client_id);
    assert.equal(await env.svc.getClient('nope'), undefined);
    assert.equal(await env.svc.getClient({ $ne: 'x' }), undefined);
  });

  // ------------------------------------------------------------ authorization request
  await check('createAuthRequest: unregistered redirect, foreign resource rejected; loopback port relaxed', async () => {
    const env = setup();
    const client = await register(env.svc);
    const { challenge } = pkce();
    await expectThrow(env.svc.createAuthRequest(client, { codeChallenge: challenge, redirectUri: 'https://evil.example/cb', resource: new URL(RESOURCE) }));
    await expectOAuthError(env.svc.createAuthRequest(client, { codeChallenge: challenge, redirectUri: CLAUDE_CB, resource: new URL('https://other.example/mcp') }), 'invalid_target');
    const id = await env.svc.createAuthRequest(client, { codeChallenge: challenge, redirectUri: 'http://localhost:51000/callback' });
    const info = await env.svc.getAuthRequest(id);
    assert.equal(info.redirectUri, 'http://localhost:51000/callback');
  });

  await check('getAuthRequest: shows client name and redirect host; request id stored hashed', async () => {
    const env = setup();
    const client = await register(env.svc);
    const { challenge } = pkce();
    const id = await env.svc.createAuthRequest(client, { codeChallenge: challenge, redirectUri: CLAUDE_CB, state: 's', scopes: ['mcp'] });
    const info = await env.svc.getAuthRequest(id);
    assert.equal(info.clientId, client.client_id);
    assert.equal(info.clientName, 'Claude');
    assert.equal(info.redirectUri, CLAUDE_CB);
    assert.equal(info.redirectHost, 'claude.ai');
    assert.deepEqual(info.scopes, ['mcp']);
    assert.ok(info.expiresAt instanceof Date);
    assert.ok(!allStored(env).includes(id), 'request id stored in plaintext');
    assert.equal(await env.svc.getAuthRequest('unknown'), null);
  });

  // ------------------------------------------------------------ approve / deny
  await check('approve flow: code + state in redirect, tokens issued, only hashes stored', async () => {
    const env = setup();
    const { redirectUrl, url, code, t, client } = await tokens(env);
    assert.ok(redirectUrl.startsWith(`${CLAUDE_CB}?`));
    assert.ok(code);
    assert.equal(url.searchParams.get('state'), 'st-123');
    assert.match(t.access_token, /^dgo_at_/);
    assert.match(t.refresh_token, /^dgo_rt_/);
    assert.equal(t.token_type, 'bearer');
    assert.equal(t.expires_in, 3600);
    const stored = allStored(env);
    for (const secret of [code, t.access_token, t.refresh_token, t.access_token.slice(7), t.refresh_token.slice(7)]) {
      assert.ok(!stored.includes(secret), `plaintext secret found in stored documents: ${secret.slice(0, 10)}…`);
    }
    const info = await env.svc.verifyAccessToken(t.access_token);
    assert.equal(info.clientId, client.client_id);
    assert.equal(info.resource, RESOURCE);
    assert.equal(info.expiresAt, Math.floor(env.clock.t / 1000) + 3600);
    const key = env.models.apiKey.docs.find((k) => String(k._id) === info.apiKeyId);
    assert.equal(key.kind, 'oauth');
    assert.equal(key.oauthClientId, client.client_id);
    assert.equal(String(key.userId), USER);
    assert.equal(key.active, true);
    assert.equal(key.expiresAt.getTime() > env.clock.t + 360 * 24 * 3600 * 1000, true);
  });

  await check('deny: error=access_denied with state, no connection, request consumed', async () => {
    const env = setup();
    const client = await register(env.svc);
    const { challenge } = pkce();
    const id = await env.svc.createAuthRequest(client, { codeChallenge: challenge, redirectUri: CLAUDE_CB, state: 'zz' });
    const { redirectUrl } = await env.svc.decide(id, USER, { approve: false });
    const u = new URL(redirectUrl);
    assert.equal(u.searchParams.get('error'), 'access_denied');
    assert.equal(u.searchParams.get('state'), 'zz');
    assert.equal(u.searchParams.get('code'), null);
    assert.equal(env.models.apiKey.docs.length, 0);
    await expectThrow(env.svc.decide(id, USER, { approve: true }));
  });

  await check('decide twice with the same request id → second throws; after 10 min → throws', async () => {
    const env = setup();
    const a = await approvedCode(env);
    await expectThrow(env.svc.decide(a.requestId, USER, { approve: true }));
    assert.equal(env.models.apiKey.docs.length, 1);
    const { challenge } = pkce();
    const id = await env.svc.createAuthRequest(a.client, { codeChallenge: challenge, redirectUri: CLAUDE_CB });
    env.advance(10 * 60 * 1000 + 1);
    assert.equal(await env.svc.getAuthRequest(id), null);
    await expectThrow(env.svc.decide(id, USER, { approve: true }));
    assert.equal(env.models.apiKey.docs.length, 1);
  });

  await check('decide: invalid user id / empty or invalid projectIds rejected', async () => {
    const env = setup();
    const client = await register(env.svc);
    const mk = async () => env.svc.createAuthRequest(client, { codeChallenge: pkce().challenge, redirectUri: CLAUDE_CB });
    await expectThrow(env.svc.decide(await mk(), 'not-an-id', { approve: true }));
    await expectThrow(env.svc.decide(await mk(), USER, { approve: true, projectIds: [] }));
    await expectThrow(env.svc.decide(await mk(), USER, { approve: true, projectIds: ['zzz'] }));
    await expectThrow(env.svc.decide(await mk(), USER, { approve: true, projectIds: [{ $ne: 1 }] }));
    assert.equal(env.models.apiKey.docs.length, 0);
  });

  await check('decide with projectIds [P1] → allowlist on both axes, customers linked to P1 (not archived)', async () => {
    const env = setup();
    await approvedCode(env, { projectIds: [String(P1)] });
    const key = env.models.apiKey.docs[0];
    assert.equal(key.projectScopeMode, 'allowlist');
    assert.deepEqual(key.allowedProjectIds.map(String), [String(P1)]);
    assert.equal(key.customerScopeMode, 'allowlist');
    assert.deepEqual(key.allowedCustomerIds.map(String).sort(), [String(C1), String(C2)].sort());
  });

  await check('decide with a project without customers → customer axis none', async () => {
    const env = setup();
    await approvedCode(env, { projectIds: [new Types.ObjectId().toString()] });
    const key = env.models.apiKey.docs[0];
    assert.equal(key.projectScopeMode, 'allowlist');
    assert.equal(key.customerScopeMode, 'none');
  });

  await check('decide without projectIds → both axes all', async () => {
    const env = setup();
    await approvedCode(env);
    const key = env.models.apiKey.docs[0];
    assert.equal(key.projectScopeMode, 'all');
    assert.equal(key.customerScopeMode, 'all');
    assert.equal(key.allowedTools, undefined);
  });

  // ------------------------------------------------------------ code exchange
  await check('challengeForCode returns the stored challenge; unknown code → invalid_grant', async () => {
    const env = setup();
    const a = await approvedCode(env);
    assert.equal(await env.svc.challengeForCode(a.client.client_id, a.code), a.challenge);
    await expectOAuthError(env.svc.challengeForCode(a.client.client_id, 'nope'), 'invalid_grant');
    await expectOAuthError(env.svc.challengeForCode('other-client', a.code), 'invalid_grant');
  });

  await check('code redeemed twice → invalid_grant and tokens of the first are revoked', async () => {
    const env = setup();
    const a = await tokens(env);
    await env.svc.verifyAccessToken(a.t.access_token);
    await expectOAuthError(env.svc.exchangeCode(a.client.client_id, a.code, a.verifier, CLAUDE_CB), 'invalid_grant');
    await expectOAuthError(env.svc.verifyAccessToken(a.t.access_token), 'invalid_token');
    await expectOAuthError(env.svc.exchangeRefresh(a.client.client_id, a.t.refresh_token), 'invalid_grant');
    assert.ok(env.events.emitted.some((e) => e.name === OAUTH_CONNECTION_REVOKED));
  });

  await check('code replay through the SDK path (challengeForCode first) also revokes', async () => {
    const env = setup();
    const a = await tokens(env);
    await expectOAuthError(env.svc.challengeForCode(a.client.client_id, a.code), 'invalid_grant');
    await expectOAuthError(env.svc.verifyAccessToken(a.t.access_token), 'invalid_token');
  });

  await check('code after 61 s → invalid_grant', async () => {
    const env = setup();
    const a = await approvedCode(env);
    env.advance(61 * 1000);
    await expectOAuthError(env.svc.challengeForCode(a.client.client_id, a.code), 'invalid_grant');
    await expectOAuthError(env.svc.exchangeCode(a.client.client_id, a.code, a.verifier, CLAUDE_CB), 'invalid_grant');
  });

  await check('wrong verifier → invalid_grant (code not burned)', async () => {
    const env = setup();
    const a = await approvedCode(env);
    await expectOAuthError(env.svc.exchangeCode(a.client.client_id, a.code, pkce().verifier, CLAUDE_CB), 'invalid_grant');
    const t = await env.svc.exchangeCode(a.client.client_id, a.code, a.verifier, CLAUDE_CB);
    assert.match(t.access_token, /^dgo_at_/);
  });

  await check('missing verifier → invalid_grant (PKCE fail-closed, code not burned)', async () => {
    const env = setup();
    const a = await approvedCode(env);
    await expectOAuthError(env.svc.exchangeCode(a.client.client_id, a.code, undefined, CLAUDE_CB), 'invalid_grant');
    await expectOAuthError(env.svc.exchangeCode(a.client.client_id, a.code, '', CLAUDE_CB), 'invalid_grant');
    const t = await env.svc.exchangeCode(a.client.client_id, a.code, a.verifier, CLAUDE_CB);
    assert.match(t.access_token, /^dgo_at_/);
  });

  await check('token responses only ever carry scope "mcp"', async () => {
    const env = setup();
    const client = await register(env.svc);
    const { verifier, challenge } = pkce();
    const id = await env.svc.createAuthRequest(client, { codeChallenge: challenge, redirectUri: CLAUDE_CB, scopes: ['mcp', 'admin', 'openid'] });
    const { redirectUrl } = await env.svc.decide(id, USER, { approve: true });
    const code = new URL(redirectUrl).searchParams.get('code');
    const t = await env.svc.exchangeCode(client.client_id, code, verifier, CLAUDE_CB);
    assert.equal(t.scope, 'mcp');
    const r = await env.svc.exchangeRefresh(client.client_id, t.refresh_token);
    assert.equal(r.scope, 'mcp');
    const plain = await tokens(env);
    assert.equal(plain.t.scope, 'mcp');
    assert.ok(!allStored(env).includes('admin'), 'unknown scope must not be persisted on tokens');
  });

  await check('verifyAccessToken: token for another resource or OAuth unconfigured → invalid_token', async () => {
    const env = setup();
    const a = await tokens(env);
    await env.svc.verifyAccessToken(a.t.access_token);
    const m = env.models;
    const other = new OAuthService(m.client, m.request, m.code, m.token, m.apiKey, m.link, env.apiKeys, env.events, env.audit,
      { resource: 'https://other.example.test/mcp', now: () => env.clock.t });
    await expectOAuthError(other.verifyAccessToken(a.t.access_token), 'invalid_token');
    const off = new OAuthService(m.client, m.request, m.code, m.token, m.apiKey, m.link, env.apiKeys, env.events, env.audit,
      { resource: null, now: () => env.clock.t });
    await expectOAuthError(off.verifyAccessToken(a.t.access_token), 'invalid_token');
  });

  await check('different redirect_uri than at authorize → invalid_grant', async () => {
    const env = setup();
    const a = await approvedCode(env);
    await expectOAuthError(env.svc.exchangeCode(a.client.client_id, a.code, a.verifier, LOCAL_CB), 'invalid_grant');
  });

  await check('code of another client → invalid_grant; foreign resource → invalid_target', async () => {
    const env = setup();
    const a = await approvedCode(env);
    const other = await register(env.svc);
    await expectOAuthError(env.svc.exchangeCode(other.client_id, a.code, a.verifier, CLAUDE_CB), 'invalid_grant');
    await expectOAuthError(env.svc.exchangeCode(a.client.client_id, a.code, a.verifier, CLAUDE_CB, new URL('https://x.example/mcp')), 'invalid_target');
  });

  // ------------------------------------------------------------ refresh
  await check('refresh rotates; old refresh again after 5 s → invalid_grant, connection stays', async () => {
    const env = setup();
    const a = await tokens(env);
    env.advance(1000);
    const t2 = await env.svc.exchangeRefresh(a.client.client_id, a.t.refresh_token, new URL(RESOURCE));
    assert.match(t2.access_token, /^dgo_at_/);
    assert.match(t2.refresh_token, /^dgo_rt_/);
    assert.notEqual(t2.refresh_token, a.t.refresh_token);
    assert.equal(t2.expires_in, 3600);
    env.advance(5000);
    await expectOAuthError(env.svc.exchangeRefresh(a.client.client_id, a.t.refresh_token), 'invalid_grant');
    await env.svc.verifyAccessToken(t2.access_token);
    const t3 = await env.svc.exchangeRefresh(a.client.client_id, t2.refresh_token);
    await env.svc.verifyAccessToken(t3.access_token);
  });

  await check('old refresh again after 11 s → whole connection revoked', async () => {
    const env = setup();
    const a = await tokens(env);
    const t2 = await env.svc.exchangeRefresh(a.client.client_id, a.t.refresh_token);
    env.advance(11 * 1000);
    await expectOAuthError(env.svc.exchangeRefresh(a.client.client_id, a.t.refresh_token), 'invalid_grant');
    await expectOAuthError(env.svc.verifyAccessToken(t2.access_token), 'invalid_token');
    await expectOAuthError(env.svc.exchangeRefresh(a.client.client_id, t2.refresh_token), 'invalid_grant');
    const key = env.models.apiKey.docs[0];
    assert.equal(key.active, false);
  });

  await check('concurrent refresh: exactly one wins, connection stays', async () => {
    const env = setup();
    const a = await tokens(env);
    const results = await Promise.allSettled([
      env.svc.exchangeRefresh(a.client.client_id, a.t.refresh_token),
      env.svc.exchangeRefresh(a.client.client_id, a.t.refresh_token),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.equal(results.find((r) => r.status === 'rejected').reason.errorCode, 'invalid_grant');
    await env.svc.verifyAccessToken(ok[0].value.access_token);
  });

  await check('refresh: other client, access token as refresh, expired → invalid_grant', async () => {
    const env = setup();
    const a = await tokens(env);
    const other = await register(env.svc);
    await expectOAuthError(env.svc.exchangeRefresh(other.client_id, a.t.refresh_token), 'invalid_grant');
    await expectOAuthError(env.svc.exchangeRefresh(a.client.client_id, a.t.access_token), 'invalid_grant');
    env.advance(30 * 24 * 3600 * 1000 + 1000);
    await expectOAuthError(env.svc.exchangeRefresh(a.client.client_id, a.t.refresh_token), 'invalid_grant');
    // the connection itself was not revoked by any of these
    assert.equal(env.models.apiKey.docs[0].active, true);
  });

  // ------------------------------------------------------------ access token
  await check('verifyAccessToken: expired after 1 h, refresh token / garbage rejected', async () => {
    const env = setup();
    const a = await tokens(env);
    await expectOAuthError(env.svc.verifyAccessToken(a.t.refresh_token), 'invalid_token');
    await expectOAuthError(env.svc.verifyAccessToken('cv_abc'), 'invalid_token');
    await expectOAuthError(env.svc.verifyAccessToken(''), 'invalid_token');
    env.advance(3600 * 1000 + 1);
    await expectOAuthError(env.svc.verifyAccessToken(a.t.access_token), 'invalid_token');
  });

  await check('verifyAccessToken: inactive or expired connection key → invalid_token', async () => {
    const env = setup();
    const a = await tokens(env);
    env.models.apiKey.docs[0].expiresAt = new Date(env.clock.t - 1);
    await expectOAuthError(env.svc.verifyAccessToken(a.t.access_token), 'invalid_token');
  });

  // ------------------------------------------------------------ revocation
  await check('revokeConnection: key inactive, tokens gone, event with apiKeyId', async () => {
    const env = setup();
    const a = await tokens(env);
    const { apiKeyId } = await env.svc.verifyAccessToken(a.t.access_token);
    await env.svc.revokeConnection(apiKeyId);
    assert.equal(env.models.apiKey.docs[0].active, false);
    assert.equal(env.models.token.docs.length, 0);
    assert.deepEqual(env.events.emitted.filter((e) => e.name === 'oauth.connection.revoked').map((e) => e.payload), [{ apiKeyId, reason: 'user' }]);
    await expectOAuthError(env.svc.verifyAccessToken(a.t.access_token), 'invalid_token');
    await env.svc.revokeConnection('garbage');
  });

  await check('revokeAllForUser: only oauth keys of that user', async () => {
    const env = setup();
    await tokens(env);
    await tokens(env);
    const standard = await env.apiKeys.generate(USER, 'cli');
    // an oauth key of another user
    await env.apiKeys.createOAuthConnection({ userId: OTHER_USER, clientId: 'c', clientName: 'Other', expiresAt: new Date(env.clock.t + 60000) });
    const n = await env.svc.revokeAllForUser(USER);
    assert.equal(n, 2);
    const byId = (id) => env.models.apiKey.docs.find((k) => String(k._id) === String(id));
    assert.equal(byId(standard.apiKey._id).active, true);
    const other = env.models.apiKey.docs.find((k) => String(k.userId) === OTHER_USER);
    assert.equal(other.active, true);
    assert.equal(env.models.apiKey.docs.filter((k) => k.kind === 'oauth' && String(k.userId) === USER && k.active).length, 0);
    assert.equal(await env.svc.revokeAllForUser('nope'), 0);
  });

  await check('revokeToken: unknown/foreign ignored, refresh revokes connection, access only itself', async () => {
    const env = setup();
    const a = await tokens(env);
    await env.svc.revokeToken(a.client.client_id, 'dgo_rt_unknown');
    await env.svc.revokeToken('other-client', a.t.refresh_token);
    await env.svc.verifyAccessToken(a.t.access_token);
    await env.svc.revokeToken(a.client.client_id, a.t.access_token);
    await expectOAuthError(env.svc.verifyAccessToken(a.t.access_token), 'invalid_token');
    assert.equal(env.models.apiKey.docs[0].active, true);
    const t2 = await env.svc.exchangeRefresh(a.client.client_id, a.t.refresh_token);
    await env.svc.revokeToken(a.client.client_id, t2.refresh_token);
    assert.equal(env.models.apiKey.docs[0].active, false);
    await expectOAuthError(env.svc.verifyAccessToken(t2.access_token), 'invalid_token');
  });

  // ------------------------------------------------------------ ApiKeysService
  await check('ApiKeysService.list hides oauth connections', async () => {
    const env = setup();
    await env.apiKeys.generate(USER, 'cli');
    await env.apiKeys.createOAuthConnection({ userId: USER, clientId: 'c', clientName: 'Claude', expiresAt: new Date(env.clock.t + 60000) });
    const listed = await env.apiKeys.list(USER);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'cli');
  });

  await check('createOAuthConnection: no usable secret, pending with the given expiry, refused for API-key actors', async () => {
    const env = setup();
    const expiresAt = new Date(env.clock.t + 10 * 60 * 1000);
    const key = await env.apiKeys.createOAuthConnection({ userId: USER, clientId: 'c', clientName: 'Claude', expiresAt, projectIds: [String(P1)], customerIds: [] });
    assert.equal(key.kind, 'oauth');
    assert.equal(key.projectScopeMode, 'allowlist');
    assert.equal(key.customerScopeMode, 'none');
    assert.match(key.keyHash, /^[0-9a-f]{64}$/);
    assert.equal(key.expiresAt.getTime(), expiresAt.getTime());
    assert.equal(key.oauthPending, true);
    assert.equal(key.oauthClientName, 'Claude');
    assert.equal(await env.apiKeys.validate('cv_whatever'), null);
    const actor = { userId: USER, username: 'u', role: 'user', apiKeyId: 'k1' };
    await expectThrow(RequestContext.run(actor, undefined, () => env.apiKeys.createOAuthConnection({ userId: USER, clientId: 'c', clientName: 'x', expiresAt })));
    await expectThrow(env.apiKeys.createOAuthConnection({ userId: 'bad', clientId: 'c', clientName: 'x', expiresAt }));
  });

  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures ? 1 : 0);
})();
