#!/usr/bin/env node
/*
 * MCP OAuth wiring (Task 2): oauthConfig, the SDK auth router on top of a
 * fake OAuthService (metadata, /authorize → consent page, /token forwards
 * the PKCE verifier, /register without SDK-generated ids, rate limits), the
 * MCP auth middleware (OAuth only on /mcp and only in the header, owner
 * re-check, API keys unchanged), and Streamable-HTTP sessions bound to the
 * credential that opened them and closed on revocation.
 *
 * Loads from dist/; run `npm run build` first. No database; real HTTP on an
 * ephemeral localhost port.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { URLSearchParams } = require('node:url');

function load(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.\n${err.message}`);
    process.exit(2);
  }
}
const { oauthConfig } = load('oauth/oauth-config.js');
const { createOAuthRouter, OAUTH_CONSENT_PATH } = load('oauth/oauth-provider.js');
const { OAUTH_CONNECTION_REVOKED } = load('oauth/oauth.service.js');
const {
  createMcpAuthMiddleware, createStreamableHttpHandler, McpSessionOwners, closeSessionsOnRevoke,
} = load('mcp-http-auth.js');

const backendRequire = createRequire(path.resolve(__dirname, '..', 'package.json'));
const express = backendRequire('express');
const { Server } = backendRequire('@modelcontextprotocol/sdk/server/index.js');
const { InvalidTokenError } = backendRequire('@modelcontextprotocol/sdk/server/auth/errors.js');
const { Types } = backendRequire('mongoose');

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`ok  ${label}`); }
  catch (err) { failures += 1; console.error(`FAIL ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

// ---------------------------------------------------------------- fixtures
const BASE = 'https://dg.example.test';
const ENV_ON = { PUBLIC_BASE_URL: BASE, AUTH_USERNAME: 'admin', AUTH_PASSWORD: 'pw' };
const CLIENT_ID = '0b9a3c1e-1111-4222-8333-944455556666';
const CB = 'https://claude.ai/api/mcp/auth_callback';
const PROJECT = new Types.ObjectId().toString();

function fixtures() {
  const users = new Map();
  const keys = new Map();
  const plain = new Map();
  const addUser = (extra = {}) => {
    const id = new Types.ObjectId();
    users.set(String(id), { _id: id, username: `u${users.size}`, role: 'user', active: true, permissions: [], projectScopeMode: 'all', allowedProjectIds: [], customerScopeMode: 'all', allowedCustomerIds: [], ...extra });
    return String(id);
  };
  const addKey = (userId, extra = {}) => {
    const id = new Types.ObjectId();
    keys.set(String(id), { _id: id, userId: new Types.ObjectId(userId), kind: 'standard', active: true, permissions: [], projectScopeMode: 'all', allowedProjectIds: [], customerScopeMode: 'all', allowedCustomerIds: [], ...extra });
    return String(id);
  };
  const apiKeys = {
    async validate(p) {
      const id = plain.get(p);
      const k = id && keys.get(id);
      return k && k.active && k.kind !== 'oauth' ? k : null;
    },
    async findActiveById(id) {
      const k = keys.get(String(id));
      return k && k.active ? k : null;
    },
  };
  const alice = addUser();
  const bob = addUser();
  const aliceKey = addKey(alice); plain.set('cv_alice', aliceKey);
  const bobKey = addKey(bob); plain.set('cv_bob', bobKey);
  const conn = addKey(alice, { kind: 'oauth', projectScopeMode: 'allowlist', allowedProjectIds: [new Types.ObjectId(PROJECT)], customerScopeMode: 'none' });
  const conn2 = addKey(bob, { kind: 'oauth' });
  return { users, keys, plain, apiKeys, alice, bob, aliceKey, bobKey, conn, conn2 };
}

function fakeOAuth() {
  const calls = { register: [], exchange: [], challenge: 0, refresh: [], revoke: [], authorize: [] };
  const tokens = new Map();
  return {
    calls, tokens,
    async registerClient(meta) {
      calls.register.push(meta);
      return { client_id: CLIENT_ID, client_id_issued_at: 1, client_name: meta.client_name, redirect_uris: meta.redirect_uris, token_endpoint_auth_method: 'none' };
    },
    async getClient(id) {
      return id === CLIENT_ID ? { client_id: CLIENT_ID, redirect_uris: [CB], token_endpoint_auth_method: 'none' } : undefined;
    },
    async createAuthRequest(client, params) { calls.authorize.push({ client, params }); return 'req-123'; },
    async challengeForCode() { calls.challenge += 1; return 'unused'; },
    async exchangeCode(clientId, code, verifier, redirectUri, resource) {
      calls.exchange.push({ clientId, code, verifier, redirectUri, resource: resource && resource.href });
      return { access_token: 'dgo_at_new', token_type: 'bearer', expires_in: 3600, refresh_token: 'dgo_rt_new', scope: 'mcp' };
    },
    async exchangeRefresh(clientId, rt, resource) {
      calls.refresh.push({ clientId, rt, resource: resource && resource.href });
      return { access_token: 'dgo_at_2', token_type: 'bearer', expires_in: 3600, refresh_token: 'dgo_rt_2', scope: 'mcp' };
    },
    async verifyAccessToken(token) {
      const info = tokens.get(token);
      if (!info) throw new InvalidTokenError('Invalid or expired access token');
      return info;
    },
    async revokeToken(clientId, token) { calls.revoke.push({ clientId, token }); },
  };
}

async function startApp({ env = ENV_ON, fx = fixtures(), svc = fakeOAuth(), authEnabled = true } = {}) {
  const cfg = oauthConfig(env);
  const app = express();
  app.set('trust proxy', false);
  if (cfg.enabled) app.use(createOAuthRouter(svc, { baseUrl: cfg.baseUrl, resourceUrl: cfg.resourceUrl }));
  app.use(express.json());
  const deps = {
    authEnabled: () => authEnabled,
    apiKeys: fx.apiKeys,
    findUserById: async (id) => fx.users.get(id) ?? null,
    oauth: cfg.enabled ? { verifyAccessToken: (t) => svc.verifyAccessToken(t), resourceUrl: cfg.resourceUrl } : null,
  };
  const seen = [];
  const record = (req, _res, next) => { seen.push({ path: req.baseUrl, user: req.user, apiKey: req.apiKey }); next(); };
  app.use('/mcp', createMcpAuthMiddleware(deps, { acceptOAuth: true }), record);
  app.use('/sse', createMcpAuthMiddleware(deps, { acceptOAuth: false }), record);
  app.get('/sse', (_req, res) => res.status(200).json({ ok: true }));
  const transports = {};
  const owners = new McpSessionOwners();
  app.all('/mcp', createStreamableHttpHandler({
    transports, owners,
    createServer: () => new Server({ name: 'check', version: '1.0.0' }, { capabilities: { tools: {} } }),
    log: () => {},
  }));
  const events = new EventEmitter();
  closeSessionsOnRevoke(events, OAUTH_CONNECTION_REVOKED, owners, () => {});
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, cfg, fx, svc, seen, events, transports, owners,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } } };

async function mcp(env, { auth, query = '', body = INIT, session } = {}) {
  const headers = { ...MCP_HEADERS };
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (session) { headers['mcp-session-id'] = session; headers['mcp-protocol-version'] = '2025-06-18'; }
  const res = await fetch(`${env.url}/mcp${query}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { res, text, status: res.status, session: res.headers.get('mcp-session-id'), www: res.headers.get('www-authenticate') };
}
async function openSession(env, auth) {
  const r = await mcp(env, { auth });
  assert.equal(r.status, 200, `initialize failed: ${r.status} ${r.text}`);
  assert.ok(r.session, 'no mcp-session-id');
  await mcp(env, { auth, session: r.session, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  return r.session;
}
const ping = (env, auth, session, id = 2) => mcp(env, { auth, session, body: { jsonrpc: '2.0', id, method: 'ping' } });
const tokenInfo = (apiKeyId) => ({ apiKeyId, clientId: CLIENT_ID, expiresAt: Math.floor(Date.now() / 1000) + 3600, resource: `${BASE}/mcp` });
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const form = (obj) => new URLSearchParams(obj).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

(async () => {
  // ------------------------------------------------------------ config
  await check('oauthConfig: off without base URL, on with base + auth, off with AUTH_ENABLED=false / no auth / http', async () => {
    assert.equal(oauthConfig({}).enabled, false);
    const on = oauthConfig(ENV_ON);
    assert.equal(on.enabled, true);
    assert.equal(on.resourceUrl.href, `${BASE}/mcp`);
    assert.equal(on.baseUrl.origin, BASE);
    assert.equal(oauthConfig({ ...ENV_ON, PUBLIC_BASE_URL: `${BASE}/` }).resourceUrl.href, `${BASE}/mcp`);
    assert.equal(oauthConfig({ ...ENV_ON, AUTH_ENABLED: 'true' }).enabled, true);
    assert.equal(oauthConfig({ ...ENV_ON, AUTH_ENABLED: 'false' }).enabled, false);
    assert.equal(oauthConfig({ PUBLIC_BASE_URL: BASE }).enabled, false, 'auth off (no credentials) → OAuth off');
    assert.equal(oauthConfig({ ...ENV_ON, PUBLIC_BASE_URL: 'http://dg.example.test' }).enabled, false);
    assert.equal(oauthConfig({ ...ENV_ON, PUBLIC_BASE_URL: 'http://localhost:8080' }).enabled, true);
    assert.equal(oauthConfig({ ...ENV_ON, PUBLIC_BASE_URL: `${BASE}/sub` }).enabled, false);
    assert.equal(oauthConfig({ ...ENV_ON, PUBLIC_BASE_URL: 'not a url' }).enabled, false);
  });

  // ------------------------------------------------------------ metadata + router
  const on = await startApp();
  try {
    await check('metadata: protected resource /mcp and authorization server', async () => {
      const prm = await (await fetch(`${on.url}/.well-known/oauth-protected-resource/mcp`)).json();
      assert.equal(prm.resource, `${BASE}/mcp`);
      assert.ok(prm.authorization_servers.some((s) => s.replace(/\/$/, '') === BASE), JSON.stringify(prm.authorization_servers));
      assert.deepEqual(prm.scopes_supported, ['mcp']);
      const as = await (await fetch(`${on.url}/.well-known/oauth-authorization-server`)).json();
      assert.equal(as.issuer.replace(/\/$/, ''), BASE);
      assert.ok(as.code_challenge_methods_supported.includes('S256'));
      assert.equal(as.authorization_endpoint, `${BASE}/authorize`);
      assert.equal(as.token_endpoint, `${BASE}/token`);
      assert.equal(as.registration_endpoint, `${BASE}/register`);
      assert.equal(as.revocation_endpoint, `${BASE}/revoke`);
    });

    await check('/authorize: redirects to the consent page with the request id', async () => {
      const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: CB, response_type: 'code', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', state: 'st', resource: `${BASE}/mcp` });
      const res = await fetch(`${on.url}/authorize?${q}`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const loc = new URL(res.headers.get('location'));
      assert.equal(`${loc.origin}${loc.pathname}`, `${BASE}${OAUTH_CONSENT_PATH}`);
      assert.equal(loc.searchParams.get('request'), 'req-123');
      const { params } = on.svc.calls.authorize[0];
      assert.equal(params.redirectUri, CB);
      assert.equal(params.state, 'st');
      assert.equal(params.resource.href, `${BASE}/mcp`);
    });

    await check('/authorize: unknown client → 400, no redirect', async () => {
      const q = new URLSearchParams({ client_id: 'nope', redirect_uri: CB, response_type: 'code', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' });
      const res = await fetch(`${on.url}/authorize?${q}`, { redirect: 'manual' });
      assert.equal(res.status, 400);
    });

    await check('/token: verifier is forwarded to the service (no local PKCE shortcut)', async () => {
      const res = await fetch(`${on.url}/token`, { method: 'POST', headers: FORM, body: form({ grant_type: 'authorization_code', code: 'code-1', code_verifier: 'v'.repeat(43), client_id: CLIENT_ID, redirect_uri: CB }) });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.scope, 'mcp');
      assert.equal(on.svc.calls.challenge, 0, 'SDK must not check PKCE itself');
      assert.equal(on.svc.calls.exchange[0].verifier, 'v'.repeat(43));
      assert.equal(on.svc.calls.exchange[0].clientId, CLIENT_ID);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });

    await check('/token: refresh passes resource, not scopes; /revoke reaches the service', async () => {
      const res = await fetch(`${on.url}/token`, { method: 'POST', headers: FORM, body: form({ grant_type: 'refresh_token', refresh_token: 'dgo_rt_x', client_id: CLIENT_ID, scope: 'admin', resource: `${BASE}/mcp` }) });
      assert.equal(res.status, 200);
      assert.deepEqual(on.svc.calls.refresh[0], { clientId: CLIENT_ID, rt: 'dgo_rt_x', resource: `${BASE}/mcp` });
      const rv = await fetch(`${on.url}/revoke`, { method: 'POST', headers: FORM, body: form({ token: 'dgo_rt_x', client_id: CLIENT_ID }) });
      assert.equal(rv.status, 200);
      assert.deepEqual(on.svc.calls.revoke[0], { clientId: CLIENT_ID, token: 'dgo_rt_x' });
    });

    await check('/register: service generates the id (SDK id generation off)', async () => {
      const res = await fetch(`${on.url}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CB], token_endpoint_auth_method: 'none' }) });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.client_id, CLIENT_ID);
      assert.equal(on.svc.calls.register[0].client_id, undefined);
      assert.equal(body.client_secret, undefined);
    });

    // ------------------------------------------------------------ /mcp auth
    await check('/mcp without credentials → 401 with WWW-Authenticate resource_metadata', async () => {
      const r = await mcp(on);
      assert.equal(r.status, 401);
      assert.ok(r.www, 'WWW-Authenticate missing');
      assert.match(r.www, /^Bearer /);
      assert.ok(r.www.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`), r.www);
    });

    await check('/mcp with valid dgo_at_ → actor from the connection (scope narrowed)', async () => {
      on.svc.tokens.set('dgo_at_alice', tokenInfo(on.fx.conn));
      on.seen.length = 0;
      const r = await mcp(on, { auth: 'dgo_at_alice' });
      assert.equal(r.status, 200, r.text);
      const { user, apiKey } = on.seen.find((s) => s.path === '/mcp');
      assert.equal(user.userId, on.fx.alice);
      assert.equal(user.apiKeyId, on.fx.conn);
      assert.equal(user.projectScopeMode, 'allowlist');
      assert.deepEqual(user.allowedProjectIds, [PROJECT]);
      assert.equal(user.customerScopeMode, 'none');
      assert.equal(String(apiKey._id), on.fx.conn);
    });

    await check('/mcp with invalid/expired dgo_at_ → 401 invalid_token', async () => {
      const r = await mcp(on, { auth: 'dgo_at_unknown' });
      assert.equal(r.status, 401);
      assert.match(r.www, /error="invalid_token"/);
      const rt = await mcp(on, { auth: 'dgo_rt_something' });
      assert.equal(rt.status, 401, 'refresh token is no access token');
    });

    await check('/mcp: revoked connection or deactivated owner → 401', async () => {
      const fx = on.fx;
      on.svc.tokens.set('dgo_at_bob', tokenInfo(fx.conn2));
      assert.equal((await mcp(on, { auth: 'dgo_at_bob' })).status, 200);
      fx.keys.get(fx.conn2).active = false;
      assert.equal((await mcp(on, { auth: 'dgo_at_bob' })).status, 401);
      fx.keys.get(fx.conn2).active = true;
      fx.users.get(fx.bob).active = false;
      const r = await mcp(on, { auth: 'dgo_at_bob' });
      assert.equal(r.status, 401);
      assert.match(r.text, /deactivated/);
      fx.users.get(fx.bob).active = true;
    });

    await check('/mcp: token pointing at a standard API key is refused', async () => {
      on.svc.tokens.set('dgo_at_forged', tokenInfo(on.fx.aliceKey));
      assert.equal((await mcp(on, { auth: 'dgo_at_forged' })).status, 401);
    });

    await check('OAuth token in the query or on /sse → 401 (no OAuth hint on /sse)', async () => {
      const q = await mcp(on, { query: '?apiKey=dgo_at_alice' });
      assert.equal(q.status, 401);
      const sse = await fetch(`${on.url}/sse`, { headers: { authorization: 'Bearer dgo_at_alice' } });
      assert.equal(sse.status, 401);
      assert.equal(sse.headers.get('www-authenticate'), null);
      const sseQ = await fetch(`${on.url}/sse?apiKey=dgo_at_alice`);
      assert.equal(sseQ.status, 401);
      const none = await fetch(`${on.url}/sse`);
      assert.equal(none.status, 401);
      assert.equal(none.headers.get('www-authenticate'), null);
    });

    await check('cv_ keys unchanged: header on /mcp, ?apiKey= on /sse and /mcp', async () => {
      on.seen.length = 0;
      const r = await mcp(on, { auth: 'cv_alice' });
      assert.equal(r.status, 200, r.text);
      assert.equal(on.seen[0].user.apiKeyId, on.fx.aliceKey);
      assert.equal((await mcp(on, { query: '?apiKey=cv_alice' })).status, 200);
      const sse = await fetch(`${on.url}/sse?apiKey=cv_alice`);
      assert.equal(sse.status, 200);
      const bad = await mcp(on, { auth: 'cv_wrong' });
      assert.equal(bad.status, 401);
    });

    await check('cv_ key of a deactivated owner → 401 (regression)', async () => {
      on.fx.users.get(on.fx.alice).active = false;
      assert.equal((await mcp(on, { auth: 'cv_alice' })).status, 401);
      on.fx.users.get(on.fx.alice).active = true;
    });

    // ------------------------------------------------------------ sessions
    await check('session bound to its credential: other key/connection → 403, same connection with new token → ok', async () => {
      on.svc.tokens.set('dgo_at_alice2', tokenInfo(on.fx.conn));
      const sOauth = await openSession(on, 'dgo_at_alice');
      const sKey = await openSession(on, 'cv_bob');
      assert.equal((await ping(on, 'dgo_at_alice', sOauth)).status, 200);
      assert.equal((await ping(on, 'dgo_at_alice2', sOauth, 3)).status, 200, 'rotated access token, same connection');
      assert.equal((await ping(on, 'cv_bob', sOauth, 4)).status, 403);
      assert.equal((await ping(on, 'cv_alice', sOauth, 5)).status, 403, 'same user, different credential');
      assert.equal((await ping(on, 'dgo_at_alice', sKey, 6)).status, 403);
      assert.equal((await ping(on, 'cv_bob', sKey, 7)).status, 200);
    });

    await check('revocation event closes the sessions of that connection only', async () => {
      on.svc.tokens.set('dgo_at_bob', tokenInfo(on.fx.conn2));
      const sX = await openSession(on, 'dgo_at_alice');
      const sX2 = await openSession(on, 'dgo_at_alice');
      const sY = await openSession(on, 'dgo_at_bob');
      const sK = await openSession(on, 'cv_bob');
      assert.ok(on.transports[sX] && on.transports[sX2]);
      on.events.emit(OAUTH_CONNECTION_REVOKED, { apiKeyId: on.fx.conn, reason: 'user' });
      await tick();
      assert.equal(on.transports[sX], undefined);
      assert.equal(on.transports[sX2], undefined);
      assert.equal((await ping(on, 'dgo_at_alice', sX)).status, 400, 'closed session is gone');
      assert.equal((await ping(on, 'dgo_at_bob', sY)).status, 200);
      assert.equal((await ping(on, 'cv_bob', sK)).status, 200);
      on.events.emit(OAUTH_CONNECTION_REVOKED, { apiKeyId: { $ne: 'x' } });
      on.events.emit(OAUTH_CONNECTION_REVOKED, null);
      await tick();
      assert.equal((await ping(on, 'dgo_at_bob', sY, 9)).status, 200, 'malformed payload ignored');
    });
  } finally {
    await on.close();
  }

  // ------------------------------------------------------------ rate limits
  await check('rate limits: /register 10/h, /authorize 30/min, /token 60/min per IP', async () => {
    const env = await startApp();
    try {
      const reg = () => fetch(`${env.url}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: [CB] }) });
      for (let i = 0; i < 10; i++) assert.equal((await reg()).status, 201, `register #${i + 1}`);
      assert.equal((await reg()).status, 429);
      const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: CB, response_type: 'code', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' });
      for (let i = 0; i < 30; i++) assert.equal((await fetch(`${env.url}/authorize?${q}`, { redirect: 'manual' })).status, 302, `authorize #${i + 1}`);
      assert.equal((await fetch(`${env.url}/authorize?${q}`, { redirect: 'manual' })).status, 429);
      const tok = () => fetch(`${env.url}/token`, { method: 'POST', headers: FORM, body: form({ grant_type: 'refresh_token', refresh_token: 'dgo_rt_x', client_id: CLIENT_ID }) });
      for (let i = 0; i < 60; i++) assert.equal((await tok()).status, 200, `token #${i + 1}`);
      assert.equal((await tok()).status, 429);
    } finally {
      await env.close();
    }
  });

  // ------------------------------------------------------------ OAuth off
  await check('OAuth off: no metadata/endpoints, 401 without WWW-Authenticate, dgo_at_ refused, cv_ works', async () => {
    const fx = fixtures();
    const svc = fakeOAuth();
    svc.tokens.set('dgo_at_alice', tokenInfo(fx.conn));
    const env = await startApp({ env: { AUTH_USERNAME: 'a', AUTH_PASSWORD: 'b' }, fx, svc });
    try {
      assert.equal((await fetch(`${env.url}/.well-known/oauth-authorization-server`)).status, 404);
      assert.equal((await fetch(`${env.url}/.well-known/oauth-protected-resource/mcp`)).status, 404);
      assert.equal((await fetch(`${env.url}/register`, { method: 'POST' })).status, 404);
      const r = await mcp(env);
      assert.equal(r.status, 401);
      assert.equal(r.www, null);
      const t = await mcp(env, { auth: 'dgo_at_alice' });
      assert.equal(t.status, 401);
      assert.equal(t.www, null);
      assert.equal((await mcp(env, { auth: 'cv_alice' })).status, 200);
    } finally {
      await env.close();
    }
  });

  await check('auth disabled: system user, no credentials needed', async () => {
    const env = await startApp({ env: {}, authEnabled: false });
    try {
      const r = await mcp(env);
      assert.equal(r.status, 200, r.text);
      assert.equal(env.seen[0].user.userId, 'system');
    } finally {
      await env.close();
    }
  });

  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures ? 1 : 0);
})();
