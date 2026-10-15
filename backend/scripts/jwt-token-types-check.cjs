#!/usr/bin/env node
/*
 * JWT-Härtung (Folge aus M-4-Rückfrage, 2026-10-15).
 *
 * - Nutzer-Access-Tokens und dg-CLI-Tokens teilen sich JWT_SECRET, trugen aber
 *   keinen Typ. Ein dg-Token an der REST-API scheiterte nur zufällig (CastError
 *   bei der Nutzer-Nachladung). Jetzt verlangt jeder Prüfer seinen `typ`.
 * - Ein gelöschter Nutzer lief mit gültigem Token ohne Scope-Felder weiter —
 *   fehlender Scope heisst „alle Projekte". Ein deaktivierter behielt Zugriff.
 *   Jetzt 401, und die Rolle kommt aus der DB.
 * - Algorithmus fest auf HS256.
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

const { accessTokenUserId, JWT_ALGORITHM, ACCESS_TOKEN_TYPE } = loadCompiled('common/access-token.js');
const { JwtStrategy } = loadCompiled('auth/strategies/jwt.strategy.js');
const { JwtAuthGuard } = loadCompiled('auth/guards/jwt-auth.guard.js');
const { WorkspaceCliTokenService } = loadCompiled('workspaces/workspace-cli-token.service.js');
const { JwtService } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/jwt'));
const jsonwebtoken = require(path.resolve(__dirname, '..', 'node_modules', 'jsonwebtoken'));

const EXPECTED_CHECKS = 7;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const SECRET = 'k'.repeat(48);
const UID = '0123456789abcdef01234567';
// Dieselben Optionen wie AuthModule/WorkspacesModule.
const jwt = new JwtService({ secret: SECRET, signOptions: { algorithm: JWT_ALGORITHM }, verifyOptions: { algorithms: [JWT_ALGORITHM] } });

(async () => {
  await check('accessTokenUserId: nur typ=access mit ObjectId-sub', async () => {
    assert.equal(accessTokenUserId({ typ: 'access', sub: UID }), UID);
    assert.equal(accessTokenUserId({ sub: UID }), null, 'untypisiertes Alt-Token');
    assert.equal(accessTokenUserId({ typ: 'dg-cli', sub: 'workspace-cli' }), null);
    assert.equal(accessTokenUserId({ typ: 'access', sub: 'workspace-cli' }), null);
    assert.equal(accessTokenUserId({ typ: 'access', sub: { $ne: 1 } }), null);
    assert.equal(accessTokenUserId(null), null);
  });

  await check('JwtStrategy.validate: dg-Token -> false, Access-Token -> Nutzer', async () => {
    const strategy = Object.create(JwtStrategy.prototype);
    const dg = new WorkspaceCliTokenService(jwt).mint('ws1', 'p1');
    assert.equal(strategy.validate(jwt.verify(dg)), false);
    assert.deepEqual(strategy.validate({ typ: ACCESS_TOKEN_TYPE, sub: UID, username: 'u', role: 'user' }),
      { userId: UID, username: 'u', role: 'user' });
  });

  await check('dg-CLI verify: Nutzer-Token und untypisiertes Token werden abgelehnt', async () => {
    const svc = new WorkspaceCliTokenService(jwt);
    assert.deepEqual(svc.verify(svc.mint('ws1', 'p1')), { workspaceId: 'ws1', projectId: 'p1' });
    assert.equal(svc.verify(jwt.sign({ typ: 'access', sub: UID, workspaceId: 'ws1', projectId: 'p1' })), null);
    assert.equal(svc.verify(jwt.sign({ workspaceId: 'ws1', projectId: 'p1' }, { subject: 'workspace-cli' })), null);
  });

  await check('Algorithmus: alg=none und HS512 werden abgelehnt', async () => {
    const none = jsonwebtoken.sign({ typ: 'access', sub: UID }, null, { algorithm: 'none' });
    assert.throws(() => jwt.verify(none));
    const hs512 = jsonwebtoken.sign({ typ: 'access', sub: UID }, SECRET, { algorithm: 'HS512' });
    assert.throws(() => jwt.verify(hs512), /invalid algorithm/);
    const ok = jwt.sign({ typ: 'access', sub: UID });
    assert.equal(JSON.parse(Buffer.from(ok.split('.')[0], 'base64url').toString()).alg, 'HS256');
  });

  // Guard: passport-Teil durch eine Attrappe ersetzt, die request.user setzt.
  const parentProto = Object.getPrototypeOf(JwtAuthGuard.prototype);
  const originalCanActivate = parentProto.canActivate;
  function runGuard(dbUser, tokenUser = { userId: UID, username: 'u', role: 'admin' }) {
    const request = { headers: { authorization: 'Bearer x' }, query: {} };
    parentProto.canActivate = async function () { request.user = { ...tokenUser }; return true; };
    const guard = Object.create(JwtAuthGuard.prototype);
    guard.reflector = { getAllAndOverride: () => false };
    guard.authService = { isAuthEnabled: () => true, findUserById: async () => dbUser };
    guard.apiKeysService = { validate: async () => null };
    const ctx = { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => null, getClass: () => null };
    return guard.canActivate(ctx).then((r) => ({ r, request }));
  }

  try {
    await check('Guard: gelöschter Nutzer -> 401 statt Zugriff ohne Scope', async () => {
      await assert.rejects(runGuard(null), (e) => e.getStatus() === 401);
    });

    await check('Guard: deaktivierter Nutzer -> 401', async () => {
      await assert.rejects(runGuard({ active: false, role: 'user' }), (e) => e.getStatus() === 401);
    });

    await check('Guard: Rolle und Scope kommen aus der DB, nicht aus dem Token', async () => {
      const { r, request } = await runGuard({
        active: true, role: 'user', projectScopeMode: 'allowlist', allowedProjectIds: ['p1'],
      });
      assert.equal(r, true);
      assert.equal(request.user.role, 'user', 'herabgestufte Rolle muss sofort greifen');
      assert.equal(request.user.projectScopeMode, 'allowlist');
    });
  } finally {
    parentProto.canActivate = originalCanActivate;
  }

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
