#!/usr/bin/env node
/*
 * Permission catalog enforcement check.
 *
 * Pins the semantics documented in `common/permissions.ts`:
 *   - empty list = unrestricted (role decides), non-empty list = allowlist,
 *     also for admins; `admin:*` entries still need the admin role
 *   - key/owner merge never turns an empty intersection into "unrestricted"
 *   - per-owner catalog checks and list filters
 *   - entry gate (REST guard, MCP tool classes) for content outside the catalog
 *   - admin routes need the matching `admin:*` permission once a list is set
 *   - service level: secrets
 *   - internal callers (no actor) still work
 *
 * Loads from dist/; run `npm run build` first.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

process.env.SECRETS_ENCRYPTION_KEY = 'c'.repeat(64);

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { RequestContext } = loadCompiled('common/request-context.js');
const { actorMay, Permission } = loadCompiled('common/permissions.js');
const { actorFromApiKey } = loadCompiled('common/actor-scope.js');
const scope = loadCompiled('common/scope-guard.js');
const { toolAccessClass, httpAccessClass } = loadCompiled('common/permission-gate.js');
const { RolesGuard } = loadCompiled('auth/guards/roles.guard.js');
const { PermissionGateGuard } = loadCompiled('auth/guards/permission-gate.guard.js');
const { PERMISSION_GATE_KEY, ADMIN_PERMISSION_KEY } = loadCompiled('auth/decorators/permission-gate.decorator.js');
const { ROLES_KEY } = loadCompiled('auth/decorators/roles.decorator.js');
const { EncryptionService } = loadCompiled('common/encryption.service.js');
const { SecretsService } = loadCompiled('secrets/secrets.service.js');

const EXPECTED_CHECKS = 14;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const statusOf = (e) => (e && typeof e.getStatus === 'function' ? e.getStatus() : undefined);
const throwsWith = (fn, status) => {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, `expected HTTP ${status}, call succeeded`);
  assert.equal(statusOf(err), status, `expected ${status}, got ${statusOf(err)}: ${err && err.message}`);
};
const rejectsWith = async (promise, status) => {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err, `expected HTTP ${status}, call succeeded`);
  assert.equal(statusOf(err), status, `expected ${status}, got ${statusOf(err)}: ${err && err.message}`);
};

const P1 = '6a0000000000000000000001';
const C1 = '6b0000000000000000000001';
const user = (extra) => ({ userId: 'u1', username: 'u', role: 'user', ...extra });
const admin = (extra) => ({ userId: 'a1', username: 'a', role: 'admin', ...extra });
const as = (actor, fn) => RequestContext.run(actor, undefined, fn);

// Minimal reflector + execution context fakes for the guards.
function guardCtx({ method = 'GET', user: u, meta = {} }) {
  const handler = () => {};
  const reflector = { getAllAndOverride: (key) => meta[key] };
  const ctx = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ method, user: u }) }),
  };
  return { reflector, ctx };
}

(async () => {
  await check('empty list: non-admin gets project/customer perms, not admin:*', () => {
    const a = user({ permissions: [] });
    assert.equal(actorMay(a, Permission.PROJECT_SECRET_READ), true);
    assert.equal(actorMay(a, Permission.ADMIN_SETTINGS_MANAGE), false);
    assert.equal(actorMay(admin({ permissions: [] }), Permission.ADMIN_SETTINGS_MANAGE), true);
  });

  await check('allowlist restricts admins too; a user list can delegate one admin:* permission', () => {
    const a = admin({ permissions: [Permission.PROJECT_TODO_READ] });
    assert.equal(actorMay(a, Permission.PROJECT_TODO_READ), true);
    assert.equal(actorMay(a, Permission.PROJECT_SECRET_READ), false);
    assert.equal(actorMay(a, Permission.ADMIN_SETTINGS_MANAGE), false);
    const u = user({ permissions: [Permission.ADMIN_SETTINGS_MANAGE] });
    assert.equal(actorMay(u, Permission.ADMIN_SETTINGS_MANAGE), true);
    assert.equal(actorMay(u, Permission.ADMIN_USER_MANAGE), false);
  });

  await check('any project:* entry implies project:read', () => {
    const a = user({ permissions: [Permission.PROJECT_TODO_READ] });
    assert.equal(actorMay(a, Permission.PROJECT_READ), true);
    assert.equal(actorMay(a, Permission.CUSTOMER_READ), false);
  });

  await check('key/owner merge: key keeps only what the owner holds, never escalates', () => {
    const key = (perms) => ({ _id: 'k1', userId: 'u1', permissions: perms });
    const owner = (perms) => ({ username: 'u', role: 'user', permissions: perms });
    const a = actorFromApiKey(key([Permission.PROJECT_TODO_READ]), owner([]));
    assert.deepEqual(a.permissions, [Permission.PROJECT_TODO_READ]);
    assert.equal(a.permissionsRestricted, true);
    const b = actorFromApiKey(key([Permission.PROJECT_TODO_READ]), owner([Permission.PROJECT_SECRET_READ]));
    assert.deepEqual(b.permissions, []);
    assert.equal(b.permissionsRestricted, true);
    assert.equal(actorMay(b, Permission.PROJECT_TODO_READ), false);
    const c = actorFromApiKey(key([]), owner([]));
    assert.equal(c.permissionsRestricted, false);
    // Escalation attempt: an unrestricted non-admin lists admin:* on their key.
    const d = actorFromApiKey(key([Permission.ADMIN_SETTINGS_MANAGE]), owner([]));
    assert.deepEqual(d.permissions, []);
    assert.equal(actorMay(d, Permission.ADMIN_SETTINGS_MANAGE), false);
  });

  await check('assertOwnerPermission: project, customer and relation axes', () => {
    as(user({ permissions: [Permission.PROJECT_SECRET_READ] }), () => {
      scope.assertOwnerPermission({ projectId: P1 }, 'secret', 'read');
      throwsWith(() => scope.assertOwnerPermission({ projectId: P1 }, 'secret', 'write'), 403);
      throwsWith(() => scope.assertOwnerPermission({ customerId: C1 }, 'secret', 'read'), 403);
      throwsWith(() => scope.assertOwnerPermission({ projectId: P1, customerId: C1 }, 'secret', 'read'), 403);
    });
  });

  await check('assertOwnerPermission: unrestricted and internal callers pass', () => {
    as(user({ permissions: [] }), () => scope.assertOwnerPermission({ customerId: C1 }, 'secret', 'write'));
    scope.assertOwnerPermission({ customerId: C1 }, 'secret', 'write');
  });

  await check('permissionFilter hides the axis without read permission', () => {
    as(user({ permissions: [Permission.PROJECT_TODO_READ] }), () => {
      assert.deepEqual(scope.permissionFilter('todo'), { customerId: null });
      assert.deepEqual(scope.permissionFilter('knowledge'), { _id: { $in: [] } });
    });
    as(user({ permissions: [] }), () => assert.deepEqual(scope.permissionFilter('todo'), {}));
  });

  await check('scopeAndPermissionFilter combines both fragments under $and', () => {
    const narrowed = user({
      permissions: [Permission.CUSTOMER_TODO_READ],
      projectScopeMode: 'allowlist',
      allowedProjectIds: [P1],
    });
    as(narrowed, () => {
      const f = scope.scopeAndPermissionFilter('todo');
      assert.ok(Array.isArray(f.$and) && f.$and.length === 2, JSON.stringify(f));
      assert.deepEqual(f.$and[1], { projectId: null });
    });
    // Unrestricted scope: still wrapped, so it cannot overwrite a caller's projectId.
    as(user({ permissions: [Permission.CUSTOMER_TODO_READ] }), () => {
      assert.deepEqual(scope.scopeAndPermissionFilter('todo'), { $and: [{ projectId: null }] });
    });
  });

  await check('MCP tool classes', () => {
    assert.equal(toolAccessClass('milestone_create'), 'write');
    assert.equal(toolAccessClass('milestone_list'), 'read');
    assert.equal(toolAccessClass('todo_update'), 'service');
    assert.equal(toolAccessClass('ssh_download'), 'write');
    assert.equal(toolAccessClass('kube_get'), 'write');
    assert.equal(toolAccessClass('workspace_read'), 'write');
    assert.equal(toolAccessClass('ssh_connection_list'), 'read');
    assert.equal(toolAccessClass('attachment_download'), 'read');
    assert.equal(httpAccessClass('GET', undefined), 'read');
    assert.equal(httpAccessClass('POST', undefined), 'write');
    assert.equal(httpAccessClass('GET', 'write'), 'write');
  });

  await check('PermissionGateGuard: content write needs project:write or customer:write', () => {
    const readOnly = user({ permissions: [Permission.PROJECT_TODO_READ] });
    const g1 = guardCtx({ method: 'POST', user: readOnly });
    throwsWith(() => new PermissionGateGuard(g1.reflector).canActivate(g1.ctx), 403);
    const g2 = guardCtx({ method: 'POST', user: user({ permissions: [Permission.PROJECT_WRITE] }) });
    assert.equal(new PermissionGateGuard(g2.reflector).canActivate(g2.ctx), true);
    const g3 = guardCtx({ method: 'GET', user: readOnly });
    assert.equal(new PermissionGateGuard(g3.reflector).canActivate(g3.ctx), true);
  });

  await check('PermissionGateGuard: service-checked routes and unrestricted actors pass', () => {
    const g1 = guardCtx({
      method: 'PUT',
      user: user({ permissions: [Permission.PROJECT_TODO_WRITE] }),
      meta: { [PERMISSION_GATE_KEY]: 'service' },
    });
    assert.equal(new PermissionGateGuard(g1.reflector).canActivate(g1.ctx), true);
    const g2 = guardCtx({ method: 'DELETE', user: user({ permissions: [] }) });
    assert.equal(new PermissionGateGuard(g2.reflector).canActivate(g2.ctx), true);
  });

  await check('RolesGuard: restricted admin needs the route admin:* permission', () => {
    const route = { [ROLES_KEY]: ['admin'], [ADMIN_PERMISSION_KEY]: Permission.ADMIN_BACKUP_MANAGE };
    const ok = guardCtx({ user: admin({ permissions: [Permission.ADMIN_BACKUP_MANAGE] }), meta: route });
    assert.equal(new RolesGuard(ok.reflector).canActivate(ok.ctx), true);
    const no = guardCtx({ user: admin({ permissions: [Permission.PROJECT_TODO_READ] }), meta: route });
    assert.equal(new RolesGuard(no.reflector).canActivate(no.ctx), false);
    // No declared permission: falls back to admin:settings:manage.
    const fb = guardCtx({ user: admin({ permissions: [Permission.ADMIN_BACKUP_MANAGE] }), meta: { [ROLES_KEY]: ['admin'] } });
    assert.equal(new RolesGuard(fb.reflector).canActivate(fb.ctx), false);
    const plain = guardCtx({ user: admin({ permissions: [] }), meta: route });
    assert.equal(new RolesGuard(plain.reflector).canActivate(plain.ctx), true);
  });

  // In-memory secret model with just the calls SecretsService makes here.
  const enc = new EncryptionService();
  const secretDoc = {
    _id: { toString: () => '6c0000000000000000000001' },
    projectId: { toString: () => P1 },
    customerId: null,
    key: 'DB_PASSWORD',
    encryptedValue: enc.encrypt('hunter2'),
    toObject() { return { ...this, _id: this._id }; },
  };
  const exec = (v) => ({ exec: async () => v });
  const secretModel = {
    findById: () => exec(secretDoc),
    find: () => ({ sort: () => exec([secretDoc]) }),
    findByIdAndDelete: () => exec(secretDoc),
  };
  const secrets = new SecretsService(secretModel, {}, enc, { emit() {} });

  await check('SecretsService: value and list need secret:read, delete needs secret:write', async () => {
    await as(user({ permissions: [Permission.PROJECT_TODO_READ] }), async () => {
      await rejectsWith(secrets.findById('6c0000000000000000000001'), 403);
      await rejectsWith(secrets.findByProject(P1), 403);
    });
    await as(user({ permissions: [Permission.PROJECT_SECRET_READ] }), async () => {
      const s = await secrets.findById('6c0000000000000000000001');
      assert.equal(s.value, 'hunter2');
      await rejectsWith(secrets.delete('6c0000000000000000000001'), 403);
    });
  });

  await check('SecretsService: unrestricted and internal callers unchanged', async () => {
    await as(user({ permissions: [] }), async () => {
      assert.equal((await secrets.findById('6c0000000000000000000001')).value, 'hunter2');
    });
    assert.equal((await secrets.findById('6c0000000000000000000001')).value, 'hunter2');
  });

  console.log(`\n${total - failures}/${total} checks passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`expected ${EXPECTED_CHECKS} checks, ran ${total}`);
    process.exit(1);
  }
  process.exit(failures ? 1 : 0);
})();
