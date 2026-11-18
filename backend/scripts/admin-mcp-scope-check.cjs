#!/usr/bin/env node
/*
 * Admin/MCP scope check (slice admin-mcp).
 *
 * Pins the fixes for:
 *   - global search (GET /api/search): narrowed actors only see in-scope
 *     results, global knowledge stays visible, a foreign projectId is 403
 *   - API-key self-escalation: an API-key actor cannot create, update or
 *     revoke API keys (user JWT and internal callers still can)
 *   - activities: explicit foreign projectId/customerId -> 403, relation rows
 *     need BOTH axes in the global feed
 *   - live events: customer axis is honoured (SSE + WS share the predicate)
 *   - notifications: customer axis in the visibility filter
 *   - MCP: admin checks on system_instructions_set / rag_reindex, scoped
 *     user_list_active, /messages re-validates the session key (static, the
 *     handlers cannot be instantiated without the whole app)
 *
 * Loads from dist/; run `npm run build` first.
 */
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { RequestContext } = loadCompiled('common/request-context.js');
const { SearchService } = loadCompiled('search/search.service.js');
const { ApiKeysService } = loadCompiled('api-keys/api-keys.service.js');
const { ActivitiesService } = loadCompiled('activities/activities.service.js');
const { isProjectEventVisible } = loadCompiled('events/event-visibility.js');
const { NotificationsService } = loadCompiled('notifications/notifications.service.js');
const { Types } = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const EXPECTED_CHECKS = 17;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const statusOf = (e) => (e && typeof e.getStatus === 'function' ? e.getStatus() : undefined);
const is403 = (e) => statusOf(e) === 403;
const is400 = (e) => statusOf(e) === 400;
const oid = () => new Types.ObjectId();

const OWN_PROJECT = oid();
const FOREIGN_PROJECT = oid();
const OWN_CUSTOMER = oid();
const FOREIGN_CUSTOMER = oid();

const SCOPED = {
  userId: 'u-scoped', username: 'scoped', role: 'user',
  projectScopeMode: 'allowlist', allowedProjectIds: [OWN_PROJECT.toString()],
  customerScopeMode: 'allowlist', allowedCustomerIds: [OWN_CUSTOMER.toString()],
};
const asScoped = (fn) => RequestContext.run(SCOPED, undefined, fn);
const asApiKey = (fn) => RequestContext.run(
  { userId: 'u-owner', username: 'owner', role: 'admin', apiKeyId: oid().toString(),
    projectScopeMode: 'allowlist', allowedProjectIds: [OWN_PROJECT.toString()] },
  undefined, fn);
const asUser = (fn) => RequestContext.run(
  { userId: 'u-owner', username: 'owner', role: 'admin', projectScopeMode: 'all', customerScopeMode: 'all' },
  undefined, fn);

// ---- in-memory model -------------------------------------------------------

function get(doc, key) {
  return key.split('.').reduce((v, k) => (v == null ? undefined : v[k]), doc);
}

/** Minimal Mongo matcher: $and/$or/$in/$ne/$exists, RegExp, dotted paths. */
function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$and') return v.every((f) => matches(doc, f));
    if (k === '$or') return v.some((f) => matches(doc, f));
    const actual = get(doc, k);
    if (v instanceof RegExp) return v.test(actual == null ? '' : String(actual));
    if (v && typeof v === 'object' && !(v instanceof Types.ObjectId) && !Array.isArray(v)) {
      if ('$in' in v) return v.$in.map(String).includes(String(actual));
      if ('$ne' in v) return String(actual) !== String(v.$ne);
      if ('$exists' in v) return (actual !== undefined) === v.$exists;
    }
    if (v === null) return actual === null || actual === undefined;
    return String(actual) === String(v);
  });
}

const counter = { writes: 0 };
function makeModel(docs) {
  const store = new Map();
  for (const d of docs) store.set(String(d._id), { ...d });
  const chain = (value) => ({
    select: () => chain(value), sort: () => chain(value), limit: () => chain(value),
    lean: () => chain(value), exec: async () => value,
  });
  return {
    _store: store,
    find: (f) => chain([...store.values()].filter((d) => matches(d, f || {}))),
    findOne: (f) => chain([...store.values()].find((d) => matches(d, f)) ?? null),
    findOneAndUpdate: (f, ops) => {
      const doc = [...store.values()].find((d) => matches(d, f)) ?? null;
      if (doc) { counter.writes += 1; Object.assign(doc, ops.$set || {}); }
      return chain(doc);
    },
    findOneAndDelete: (f) => {
      const doc = [...store.values()].find((d) => matches(d, f)) ?? null;
      if (doc) { counter.writes += 1; store.delete(String(doc._id)); }
      return chain(doc);
    },
    async create(doc) {
      counter.writes += 1;
      const s = { _id: oid(), ...doc };
      store.set(String(s._id), s);
      return s;
    },
  };
}

(async () => {
  // ---- search --------------------------------------------------------------
  const search = new SearchService(
    makeModel([
      { _id: oid(), projectId: OWN_PROJECT, title: 'needle own', description: '' },
      { _id: oid(), projectId: FOREIGN_PROJECT, title: 'needle foreign', description: '' },
      { _id: oid(), projectId: OWN_PROJECT, customerId: FOREIGN_CUSTOMER, title: 'needle relation', description: '' },
    ]),
    makeModel([
      { _id: oid(), topic: 'needle global', content: '' },
      { _id: oid(), projectId: FOREIGN_PROJECT, topic: 'needle foreign k', content: '' },
      { _id: oid(), customerId: FOREIGN_CUSTOMER, topic: 'needle foreign customer k', content: '' },
    ]),
    makeModel([{ _id: oid(), projectId: FOREIGN_PROJECT, version: 'needle', summary: '' }]),
    makeModel([]),
    makeModel([{ _id: oid(), projectId: FOREIGN_PROJECT, name: 'needle ms', description: '' }]),
  );

  await check('search: narrowed actor without projectId sees only in-scope + global', async () => {
    const res = await asScoped(() => search.search('needle'));
    assert.deepEqual(res.map((r) => r.title).sort(), ['needle global', 'needle own']);
  });
  await check('search: explicit foreign projectId -> 403', async () => {
    await assert.rejects(asScoped(() => search.search('needle', FOREIGN_PROJECT.toString())), is403);
  });
  await check('search: invalid projectId -> 400 (no CastError)', async () => {
    await assert.rejects(asScoped(() => search.search('needle', 'not-an-id')), is400);
  });
  await check('search: internal caller (no actor) sees everything', async () => {
    const res = await search.search('needle');
    assert.equal(res.length, 8);
  });

  // ---- api keys --------------------------------------------------------------
  const keyModel = makeModel([]);
  const keys = new ApiKeysService(keyModel, { record: async () => {} });
  const ownerId = oid().toString();
  const existing = await keys.generate(ownerId, 'existing'); // internal: allowed

  await check('api-keys: API-key actor cannot create a key', async () => {
    const before = keyModel._store.size;
    await assert.rejects(asApiKey(() => keys.generate(ownerId, 'escalate')), is403);
    assert.equal(keyModel._store.size, before);
  });
  await check('api-keys: API-key actor cannot widen a key via update', async () => {
    counter.writes = 0;
    await assert.rejects(
      asApiKey(() => keys.update(existing.apiKey._id.toString(), ownerId, { projectScopeMode: 'all', allowedTools: null })),
      is403,
    );
    assert.equal(counter.writes, 0);
  });
  await check('api-keys: API-key actor cannot revoke keys', async () => {
    await assert.rejects(asApiKey(() => keys.revoke(existing.apiKey._id.toString(), ownerId)), is403);
    assert.ok(keyModel._store.has(existing.apiKey._id.toString()));
  });
  await check('api-keys: user session (JWT) can still create and revoke', async () => {
    const created = await asUser(() => keys.generate(ownerId, 'via-ui'));
    await asUser(() => keys.revoke(created.apiKey._id.toString(), ownerId));
    assert.ok(!keyModel._store.has(created.apiKey._id.toString()));
  });
  await check('api-keys: isSameKey matches only the session key', async () => {
    const other = await keys.generate(ownerId, 'other');
    assert.equal(keys.isSameKey(existing.key, existing.apiKey), true);
    assert.equal(keys.isSameKey(other.key, existing.apiKey), false);
    assert.equal(keys.isSameKey(existing.key, {}), false);
  });

  // ---- activities ------------------------------------------------------------
  const activities = new ActivitiesService(makeModel([
    { _id: oid(), projectId: OWN_PROJECT, summary: 'own' },
    { _id: oid(), projectId: FOREIGN_PROJECT, summary: 'foreign' },
    { _id: oid(), projectId: OWN_PROJECT, customerId: FOREIGN_CUSTOMER, summary: 'relation' },
    { _id: oid(), customerId: OWN_CUSTOMER, summary: 'own customer' },
    { _id: oid(), summary: 'global' },
  ]));
  await check('activities: foreign projectId / customerId -> 403', async () => {
    await assert.rejects(asScoped(() => activities.findByProject(FOREIGN_PROJECT.toString())), is403);
    await assert.rejects(asScoped(() => activities.findByCustomer(FOREIGN_CUSTOMER.toString())), is403);
  });
  await check('activities: own project feed hides the foreign-customer relation row', async () => {
    const rows = await asScoped(() => activities.findByProject(OWN_PROJECT.toString()));
    assert.deepEqual(rows.map((r) => r.summary), ['own']);
  });
  await check('activities: global feed needs both axes, keeps ownerless rows', async () => {
    const rows = await asScoped(() => activities.findAllVisible(50));
    assert.deepEqual(rows.map((r) => r.summary).sort(), ['global', 'own', 'own customer']);
  });

  // ---- events ----------------------------------------------------------------
  await check('events: customer axis is enforced, ownerless events pass', async () => {
    const ev = (extra) => ({ projectId: null, entity: 'contact', action: 'updated', ...extra });
    assert.equal(isProjectEventVisible(ev({ customerId: FOREIGN_CUSTOMER.toString() }), 'u-scoped', SCOPED), false);
    assert.equal(isProjectEventVisible(ev({ customerId: OWN_CUSTOMER.toString() }), 'u-scoped', SCOPED), true);
    assert.equal(isProjectEventVisible(ev({}), 'u-scoped', SCOPED), true);
    assert.equal(
      isProjectEventVisible(ev({ projectId: OWN_PROJECT.toString(), customerId: FOREIGN_CUSTOMER.toString() }), 'u-scoped', SCOPED),
      false,
    );
  });

  // ---- notifications ---------------------------------------------------------
  const notifications = new NotificationsService(
    makeModel([
      { _id: oid(), title: 'broadcast', body: '', userId: null, projectId: null },
      { _id: oid(), title: 'foreign customer', body: '', userId: null, projectId: null, customerId: FOREIGN_CUSTOMER.toString() },
      { _id: oid(), title: 'own customer', body: '', userId: null, projectId: null, customerId: OWN_CUSTOMER.toString() },
    ]),
    { emit: () => {} }, {}, {}, makeModel([]),
  );
  await check('notifications: customer-bound notification hidden from foreign actors', async () => {
    const rows = await asScoped(() => notifications.findAll(30));
    assert.deepEqual(rows.map((r) => r.title).sort(), ['broadcast', 'own customer']);
  });

  // ---- MCP (static: handlers need the whole app) ----------------------------
  const mcpSrc = fs.readFileSync(path.resolve(__dirname, '..', 'dist', 'mcp-tools.js'), 'utf8');
  const caseBody = (name) => {
    const start = mcpSrc.indexOf(`case '${name}':`);
    assert.ok(start >= 0, `case ${name} found`);
    return mcpSrc.slice(start, mcpSrc.indexOf('break;', start));
  };
  await check('mcp: system_instructions_set and rag_reindex require admin', async () => {
    assert.match(caseBody('system_instructions_set'), /assertAdmin\)?\(['"]system_instructions_set/);
    assert.match(caseBody('rag_reindex'), /assertAdmin\)?\(['"]rag_reindex/);
  });
  await check('mcp: user_list_active filters non-admins by shared project', async () => {
    const body = mcpSrc.slice(mcpSrc.indexOf("case 'user_list_active':"), mcpSrc.indexOf("case 'ask_user':"));
    assert.match(body, /sharesProject\(/);
    assert.match(body, /role === 'admin'/);
  });
  await check('main: /messages re-validates the session key and pins it', async () => {
    const mainSrc = fs.readFileSync(path.resolve(__dirname, '..', 'dist', 'main.js'), 'utf8');
    assert.match(mainSrc, /MCP_SESSION_REVALIDATE_MS/);
    assert.match(mainSrc, /apiKeysService\.findActiveById\(keyId\)/);
    assert.match(mainSrc, /apiKeysService\.isSameKey\(presented/);
  });

  if (total !== EXPECTED_CHECKS) {
    failures += 1;
    console.error(`✗ expected ${EXPECTED_CHECKS} checks, ran ${total}`);
  }
  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures ? 1 : 0);
})();
