#!/usr/bin/env node
/*
 * API-key tool allowlist on REST.
 *
 * A key with `allowedTools` is an MCP-only key. Before this check existed the
 * allowlist only applied to /mcp and /sse; the same key reached every REST
 * route its owner could, including plaintext secrets. Pinned here:
 *   - key with allowlist -> 403 on an unmapped REST route
 *   - key with allowlist -> allowed on a route mapped via @McpToolEquivalent
 *     to a tool on the list, 403 when the tool is not on the list
 *   - key without allowlist (null/undefined) -> unchanged, allowed
 *   - an empty allowlist blocks everything, including mapped routes
 *
 * Loads from dist/; run `npm run build` first.
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

const { JwtAuthGuard } = loadCompiled('auth/guards/jwt-auth.guard.js');
const { MCP_TOOL_EQUIVALENT_KEY } = loadCompiled('auth/decorators/mcp-tool-equivalent.decorator.js');
const { WorkspaceFsController } = loadCompiled('workspaces/workspace-fs.controller.js');
const { Reflector } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/core'));

const EXPECTED_CHECKS = 6;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const statusOf = (e) => (typeof e.getStatus === 'function' ? e.getStatus() : e.status);
const OWNER = { _id: 'u1', username: 'owner', role: 'admin', active: true };

function guardFor(apiKey) {
  return new JwtAuthGuard(
    new Reflector(),
    { isAuthEnabled: () => true, findUserById: async () => OWNER },
    { validate: async (plain) => (plain === 'cv_test' ? apiKey : null) },
    { peek: () => false },
  );
}

/** Minimal ExecutionContext; `tool` is the handler's @McpToolEquivalent value. */
function ctx(tool) {
  function handler() {}
  if (tool) Reflect.defineMetadata(MCP_TOOL_EQUIVALENT_KEY, tool, handler);
  class Ctrl {}
  const req = { headers: { authorization: 'Bearer cv_test' }, query: {} };
  return {
    req,
    context: {
      getHandler: () => handler,
      getClass: () => Ctrl,
      switchToHttp: () => ({ getRequest: () => req }),
    },
  };
}

const key = (allowedTools) => ({ _id: 'k1', userId: 'u1', allowedTools });

(async () => {
  await check('allowlist key on an unmapped REST route -> 403', async () => {
    const { context } = ctx(undefined);
    await assert.rejects(() => guardFor(key(['todo_list'])).canActivate(context), (e) => statusOf(e) === 403);
  });

  await check('allowlist key on a route mapped to an allowed tool -> allowed', async () => {
    const { context, req } = ctx('attachment_download');
    assert.equal(await guardFor(key(['attachment_download'])).canActivate(context), true);
    assert.equal(req.user.apiKeyId, 'k1');
  });

  await check('allowlist key on a route mapped to a tool NOT on the list -> 403', async () => {
    const { context } = ctx('attachment_download');
    await assert.rejects(() => guardFor(key(['todo_list'])).canActivate(context), (e) => statusOf(e) === 403);
  });

  await check('key without allowlist -> unchanged, allowed', async () => {
    for (const tools of [undefined, null]) {
      const { context } = ctx(undefined);
      assert.equal(await guardFor(key(tools)).canActivate(context), true);
    }
  });

  await check('empty allowlist blocks mapped routes too', async () => {
    const { context } = ctx('attachment_download');
    await assert.rejects(() => guardFor(key([])).canActivate(context), (e) => statusOf(e) === 403);
  });

  await check('workspace IDE file routes carry no mapping -> an allowlist key gets 403 on every one', async () => {
    const proto = WorkspaceFsController.prototype;
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && !['gate', 'audit'].includes(n));
    assert.ok(handlers.length >= 10, 'expected the IDE routes');
    for (const name of handlers) {
      const req = { headers: { authorization: 'Bearer cv_test' }, query: {} };
      const context = {
        getHandler: () => proto[name],
        getClass: () => WorkspaceFsController,
        switchToHttp: () => ({ getRequest: () => req }),
      };
      await assert.rejects(
        () => guardFor(key(['workspace_read'])).canActivate(context),
        (e) => statusOf(e) === 403,
        name,
      );
    }
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Expected ${EXPECTED_CHECKS} checks, ran ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
