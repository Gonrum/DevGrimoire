#!/usr/bin/env node
/*
 * OAuth consent endpoint (Task 3): OAuthController on a fake OAuthService.
 * API-key actors are refused, projectIds must be valid ObjectIds the actor
 * may access, unknown/expired requests are 404, `decide` gets the userId from
 * the authenticated actor only, and the decision DTO validates its shape.
 *
 * Loads from dist/; run `npm run build` first. No database.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

function load(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.\n${err.message}`);
    process.exit(2);
  }
}
const { OAuthController } = load('oauth/oauth.controller.js');
const { OAuthDecisionDto } = load('oauth/dto/oauth-decision.dto.js');
const backendRequire = createRequire(path.resolve(__dirname, '..', 'package.json'));
const { validate } = backendRequire('class-validator');
const { plainToInstance } = backendRequire('class-transformer');

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

const P1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const P2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const USER = 'cccccccccccccccccccccccc';

function fakeService() {
  const calls = { decide: [], get: [] };
  return {
    calls,
    async getAuthRequest(id) {
      calls.get.push(id);
      if (id !== 'good') return null;
      return {
        clientId: 'x', clientName: 'Claude', redirectUri: 'https://claude.ai/cb?x=1',
        redirectHost: 'claude.ai', scopes: ['mcp'], expiresAt: new Date('2030-01-01T00:00:00Z'),
      };
    },
    async decide(id, userId, d) {
      calls.decide.push({ id, userId, d });
      return { redirectUrl: 'https://claude.ai/cb?code=abc' };
    },
  };
}
const jwtReq = (over = {}) => ({
  user: { userId: USER, username: 'u', role: 'user', projectScopeMode: 'all', allowedProjectIds: [], ...over },
});

(async () => {
  await check('GET returns only the display fields', async () => {
    const c = new OAuthController(fakeService());
    const r = await c.getRequest('good', jwtReq());
    assert.deepEqual(Object.keys(r).sort(), ['clientName', 'expiresAt', 'redirectHost', 'redirectUri']);
    assert.equal(r.redirectHost, 'claude.ai');
  });
  await check('GET unknown/expired request -> 404', async () => {
    const c = new OAuthController(fakeService());
    assert.equal(await status(() => c.getRequest('nope', jwtReq())), 404);
  });
  await check('API-key actors are refused with 403 on GET and POST (service untouched)', async () => {
    const svc = fakeService();
    const c = new OAuthController(svc);
    const viaApiKeyObj = { ...jwtReq(), apiKey: { _id: 'k' } };
    const viaActorField = jwtReq({ apiKeyId: 'k' });
    for (const req of [viaApiKeyObj, viaActorField]) {
      assert.equal(await status(() => c.getRequest('good', req)), 403);
      assert.equal(await status(() => c.decide('good', { approve: true }, req)), 403);
    }
    assert.equal(svc.calls.get.length, 0);
    assert.equal(svc.calls.decide.length, 0);
  });
  await check('missing actor -> 403', async () => {
    const c = new OAuthController(fakeService());
    assert.equal(await status(() => c.getRequest('good', {})), 403);
    assert.equal(await status(() => c.decide('good', { approve: true }, {})), 403);
  });
  await check('decide uses the actor userId, never a body field', async () => {
    const svc = fakeService();
    const c = new OAuthController(svc);
    const r = await c.decide('good', { approve: true, userId: 'dddddddddddddddddddddddd' }, jwtReq());
    assert.deepEqual(r, { redirectUrl: 'https://claude.ai/cb?code=abc' });
    assert.equal(svc.calls.decide[0].userId, USER);
    assert.deepEqual(svc.calls.decide[0].d, { approve: true });
  });
  await check('projectIds pass through when the actor may access them', async () => {
    const svc = fakeService();
    const c = new OAuthController(svc);
    await c.decide('good', { approve: true, projectIds: [P1, P2] },
      jwtReq({ projectScopeMode: 'allowlist', allowedProjectIds: [P1, P2] }));
    assert.deepEqual(svc.calls.decide[0].d, { approve: true, projectIds: [P1, P2] });
  });
  await check('foreign project -> 403, service not called', async () => {
    const svc = fakeService();
    const c = new OAuthController(svc);
    const req = jwtReq({ projectScopeMode: 'allowlist', allowedProjectIds: [P1] });
    assert.equal(await status(() => c.decide('good', { approve: true, projectIds: [P1, P2] }, req)), 403);
    assert.equal(svc.calls.decide.length, 0);
  });
  await check('invalid / non-array / empty projectIds -> 400 before any lookup', async () => {
    const svc = fakeService();
    const c = new OAuthController(svc);
    for (const bad of [['not-an-id'], [{ $ne: null }], 'abc', [], [123]]) {
      assert.equal(await status(() => c.decide('good', { approve: true, projectIds: bad }, jwtReq())), 400, JSON.stringify(bad));
    }
    assert.equal(svc.calls.decide.length, 0);
  });
  await check('deny ignores projectIds and still reaches decide', async () => {
    const svc = fakeService();
    const c = new OAuthController(svc);
    await c.decide('good', { approve: false, projectIds: ['junk'] }, jwtReq());
    assert.deepEqual(svc.calls.decide[0].d, { approve: false });
  });
  await check('non-boolean approve -> 400', async () => {
    const c = new OAuthController(fakeService());
    assert.equal(await status(() => c.decide('good', { approve: 'yes' }, jwtReq())), 400);
  });
  await check('DTO: accepts valid, rejects bad shapes', async () => {
    const ok = plainToInstance(OAuthDecisionDto, { approve: true, projectIds: [P1] });
    assert.equal((await validate(ok)).length, 0);
    for (const bad of [{ approve: 'x' }, { approve: true, projectIds: ['zz'] }, { approve: true, projectIds: 'a' }, {}]) {
      assert.ok((await validate(plainToInstance(OAuthDecisionDto, bad))).length > 0, JSON.stringify(bad));
    }
  });

  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures ? 1 : 0);
})();
