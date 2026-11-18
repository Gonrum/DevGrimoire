#!/usr/bin/env node
/*
 * customers-infra scope check.
 *
 * Pins the scope fixes for the customer/infrastructure slice:
 *   - EnvironmentsService: by-id get/update/delete, list by owner and create
 *     check the actor's scope (variables carry plaintext values)
 *   - ContactsService: by-id paths check the contact's customer; the route's
 *     :customerId must match
 *   - CustomerTransferService: import rebuilds documents from allowlists
 *     (no projectId, scope, ownedBy-ids, createdByUserId, cross refs), export filters
 *     relation documents by the project axis
 *   - CustomersService links: mutations need both axes, lists filter the
 *     other axis
 *   - Stacks / customer templates: writes need admin, reads stay open
 *   - Outbound guard: minio, MINIO_ENDPOINT and the default gateway count as
 *     instance services
 * Internal callers (no actor) keep working everywhere.
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

const { RequestContext } = loadCompiled('common/request-context.js');
const { EnvironmentsService } = loadCompiled('environments/environments.service.js');
const { ContactsService } = loadCompiled('contacts/contacts.service.js');
const { CustomersService } = loadCompiled('customers/customers.service.js');
const { CustomerTransferService } = loadCompiled('customer-transfer/customer-transfer.service.js');
const { StacksService } = loadCompiled('stacks/stacks.service.js');
const { CustomerTemplatesService } = loadCompiled('customer-templates/customer-templates.service.js');
const { createOutboundGuard, parseProcNetRoute, OutboundBlockedException } = loadCompiled('common/outbound-guard.js');
const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const EXPECTED_CHECKS = 14;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const statusOf = (e) => (e && typeof e.getStatus === 'function' ? e.getStatus() : e && e.status);
const oid = () => new mongoose.Types.ObjectId();
const OID = (s) => new mongoose.Types.ObjectId(s);

const OWN_P = oid().toString();
const FOREIGN_P = oid().toString();
const OWN_C = oid().toString();
const FOREIGN_C = oid().toString();
const USER_ID = oid().toString();

const narrowed = {
  userId: USER_ID, username: 'narrow', role: 'user',
  projectScopeMode: 'allowlist', allowedProjectIds: [OWN_P],
  customerScopeMode: 'allowlist', allowedCustomerIds: [OWN_C],
};
const admin = { userId: oid().toString(), username: 'root', role: 'admin', projectScopeMode: 'all', customerScopeMode: 'all' };
// Non-admin with unrestricted scope: imports require unrestricted scope, since
// a narrowed actor could not see the freshly created customer.
const fullUser = { userId: USER_ID, username: 'full', role: 'user', projectScopeMode: 'all', customerScopeMode: 'all' };

const as = (actor, fn) => RequestContext.run(actor, undefined, fn);
async function rejectsWith(p, status) {
  await assert.rejects(p, (e) => { assert.equal(statusOf(e), status, e && e.message); return true; });
}

const q = (value) => ({ exec: async () => value, sort() { return this; }, lean() { return this; }, select() { return this; } });

/** Minimal by-id model over a Map; records writes. */
function mapModel(docs) {
  const byId = new Map(docs.map((d) => [d._id.toString(), d]));
  const writes = [];
  return {
    writes,
    findById: (id) => q(byId.get(String(id)) ?? null),
    findByIdAndUpdate: (id, upd) => { writes.push(['update', String(id), upd]); return q(byId.get(String(id)) ?? null); },
    findByIdAndDelete: (id) => { writes.push(['delete', String(id)]); return q(byId.get(String(id)) ?? null); },
    find: (filter) => { writes.push(['find', filter]); return q(docs); },
    create: async (dto) => { writes.push(['create', dto]); return { _id: oid(), ...dto }; },
  };
}

const customersFake = {
  // Mirrors the real CustomersService.findById scope check.
  findById: async (id) => {
    const a = RequestContext.getUser();
    if (a && a.customerScopeMode === 'allowlist' && !a.allowedCustomerIds.includes(String(id))) {
      throw Object.assign(new Error('Customer not in scope'), { status: 403 });
    }
    return { _id: OID(id), name: 'Acme' };
  },
};
const events = { emit: () => true };

(async () => {
  // ---------------------------------------------------------------- environments
  const ownEnv = { _id: oid(), projectId: OID(OWN_P), name: 'own', variables: [{ key: 'K', value: 'plain' }] };
  const foreignEnv = { _id: oid(), projectId: OID(FOREIGN_P), name: 'foreign', variables: [{ key: 'K', value: 'plain' }] };
  const foreignCustEnv = { _id: oid(), customerId: OID(FOREIGN_C), name: 'fc' };

  await check('Environments: foreign by-id get/update/delete -> 403, no write', async () => {
    const model = mapModel([ownEnv, foreignEnv, foreignCustEnv]);
    const svc = new EnvironmentsService(model, customersFake);
    await as(narrowed, async () => {
      await rejectsWith(svc.findById(foreignEnv._id.toString()), 403);
      await rejectsWith(svc.findById(foreignCustEnv._id.toString()), 403);
      await rejectsWith(svc.update(foreignEnv._id.toString(), { name: 'x' }), 403);
      await rejectsWith(svc.delete(foreignEnv._id.toString()), 403);
      assert.equal((await svc.findById(ownEnv._id.toString())).name, 'own');
    });
    assert.deepEqual(model.writes.filter((w) => w[0] !== 'find'), []);
  });

  await check('Environments: list/create for a foreign owner -> 403; internal caller passes', async () => {
    const model = mapModel([foreignEnv]);
    const svc = new EnvironmentsService(model, customersFake);
    await as(narrowed, async () => {
      await rejectsWith(svc.findByProject(FOREIGN_P), 403);
      await rejectsWith(svc.findByCustomer(FOREIGN_C), 403);
      await rejectsWith(svc.create({ projectId: FOREIGN_P, name: 'x' }), 403);
      await svc.findByProject(OWN_P);
    });
    assert.equal((await svc.findById(foreignEnv._id.toString())).name, 'foreign');
    await svc.update(foreignEnv._id.toString(), { name: 'y' });
  });

  // ---------------------------------------------------------------- contacts
  await check('Contacts: foreign by-id paths -> 403, route customer mismatch -> 404', async () => {
    const foreign = { _id: oid(), customerId: OID(FOREIGN_C), name: 'f' };
    const own = { _id: oid(), customerId: OID(OWN_C), name: 'o' };
    const model = mapModel([foreign, own]);
    const svc = new ContactsService(model, customersFake, events);
    await as(narrowed, async () => {
      await rejectsWith(svc.findById(foreign._id.toString()), 403);
      await rejectsWith(svc.update(foreign._id.toString(), { name: 'x' }), 403);
      await rejectsWith(svc.remove(foreign._id.toString()), 403);
      // own contact addressed through another (own-scope) customer URL
      const otherOwn = oid().toString();
      await rejectsWith(svc.findById(own._id.toString(), otherOwn), 404);
      assert.equal((await svc.findById(own._id.toString(), OWN_C)).name, 'o');
    });
    assert.deepEqual(model.writes, []);
    // internal (MCP stdio / scheduler) without actor
    assert.equal((await svc.findById(foreign._id.toString())).name, 'f');
  });

  // ---------------------------------------------------------------- customer import / export
  function transferSetup() {
    const inserted = {};
    const insertModel = (name) => ({
      insertMany: async (docs) => { inserted[name] = docs; return docs; },
      find: (filter) => { (inserted.__finds ??= []).push([name, filter]); return q([]); },
    });
    const newCustomerId = oid();
    const svc = new CustomerTransferService(
      {
        create: async (dto) => ({ _id: newCustomerId, ...dto }),
        findById: async (id) => ({ _id: OID(id), name: 'Acme', toObject() { return { _id: OID(id), name: 'Acme' }; } }),
      },
      {},
      { exists: async () => null },
      insertModel('contacts'), insertModel('knowledge'), insertModel('todos'), insertModel('environments'),
      insertModel('secrets'), insertModel('research'), insertModel('recurringTasks'),
    );
    return { svc, inserted, newCustomerId };
  }

  const srcEnvId = oid().toString();
  const payload = {
    _exportVersion: 1,
    customer: { name: 'Imported' },
    contacts: [{ _id: oid().toString(), name: 'c', projectId: FOREIGN_P, customerId: FOREIGN_C }],
    knowledge: [{ topic: 't', content: 'x', scope: 'global', projectId: FOREIGN_P, sourceQuestionId: oid().toString() }],
    todos: [{ title: 't', projectId: FOREIGN_P, milestoneId: oid().toString(), blockedBy: [oid().toString()], number: 99 }],
    environments: [{ _id: srcEnvId, name: 'prod', projectId: FOREIGN_P, variables: [{ key: 'A', value: 'b' }] }],
    secrets: [
      { key: 'S1', encryptedValue: 'blob', environmentId: srcEnvId, ownedBySshConnectionId: oid().toString(), projectId: FOREIGN_P },
      { key: 'S2', encryptedValue: 'blob', environmentId: oid().toString(), ownedByKubeClusterId: oid().toString() },
    ],
    research: [{ title: 'r', content: 'c', status: 'queued', ownerUserId: oid().toString(), relatedKnowledge: [{ id: 'x' }] }],
    recurringTasks: [{ title: 'rt', frequency: 'daily', nextRun: new Date().toISOString(), action: 'chat', chat: { prompt: 'p' }, createdByUserId: admin.userId, milestoneId: oid().toString() }],
  };

  await check('Customer import by a narrowed actor -> 403 before anything is written', async () => {
    const { svc, inserted } = transferSetup();
    await rejectsWith(as(narrowed, () => svc.importCustomer(payload)), 403);
    assert.equal(Object.values(inserted).flat().length, 0, 'nothing may be inserted');
  });

  await check('Customer import: owner, scope, ownership and cross refs are not taken from the file', async () => {
    const { svc, inserted, newCustomerId } = transferSetup();
    const res = await as(fullUser, () => svc.importCustomer(payload));
    const forbidden = ['projectId', 'ownedBySshConnectionId', 'ownedByKubeClusterId', 'sourceQuestionId', 'milestoneId', 'blockedBy', 'relatedKnowledge'];
    for (const [section, docs] of Object.entries(inserted)) {
      if (section.startsWith('__')) continue;
      for (const doc of docs) {
        for (const f of forbidden) assert.ok(!(f in doc), `${section}.${f} leaked`);
        assert.equal(String(doc.customerId), String(newCustomerId), `${section}.customerId`);
      }
    }
    assert.equal(inserted.knowledge[0].scope, 'customer');
    assert.equal(inserted.todos[0].number, 1);
    assert.equal(inserted.research[0].status, 'done');
    assert.equal(String(inserted.research[0].ownerUserId), USER_ID);
    assert.equal(String(inserted.recurringTasks[0].createdByUserId), USER_ID);
    assert.equal(res.imported.secrets, 2);
  });

  await check('Customer import: secret environmentId remapped to the imported env, unknown -> null', async () => {
    const { svc, inserted } = transferSetup();
    await as(fullUser, () => svc.importCustomer(payload));
    const env = inserted.environments[0];
    assert.notEqual(String(env._id), srcEnvId);
    assert.equal(inserted.secrets[0].environmentId, String(env._id));
    assert.equal(inserted.secrets[1].environmentId, null);
  });

  await check('Customer import without actor: chat tasks fall back to todo tasks', async () => {
    const { svc, inserted } = transferSetup();
    const res = await svc.importCustomer(payload);
    assert.equal(inserted.recurringTasks[0].action, 'todo');
    assert.ok(!('chat' in inserted.recurringTasks[0]));
    assert.ok(!('createdByUserId' in inserted.recurringTasks[0]));
    assert.ok(res.warnings.some((w) => w.includes('recurring chat task')));
  });

  await check('Customer export: queries carry the project-axis scope filter for narrowed actors', async () => {
    const { svc, inserted } = transferSetup();
    await as(narrowed, () => svc.exportCustomer(OWN_C));
    assert.equal(inserted.__finds.length, 7);
    for (const [name, filter] of inserted.__finds) {
      assert.ok(Array.isArray(filter.$and), `${name} has no scope clause`);
      assert.ok(JSON.stringify(filter.$and).includes(OWN_P), `${name} not restricted to own projects`);
      assert.ok(!JSON.stringify(filter.$and).includes(FOREIGN_P));
    }
    const internal = transferSetup();
    await internal.svc.exportCustomer(OWN_C);
    for (const [, filter] of internal.inserted.__finds) assert.ok(!('$and' in filter));
  });

  // ---------------------------------------------------------------- customer-project links
  await check('Customer links: mutating a link to a foreign project -> 403; lists filter the other axis', async () => {
    const foreignLink = { _id: oid(), customerId: OID(OWN_C), projectId: OID(FOREIGN_P) };
    const writes = [];
    const finds = [];
    const linkModel = {
      findOne: () => q(foreignLink),
      findOneAndUpdate: () => { writes.push('update'); return q(foreignLink); },
      findOneAndDelete: () => { writes.push('delete'); return q(foreignLink); },
      find: (filter) => { finds.push(filter); return q([]); },
    };
    const customerModel = { findById: () => q({ _id: OID(OWN_C), name: 'Acme' }) };
    const svc = new CustomersService(customerModel, linkModel, {}, { findById: async () => ({}) }, events);
    await as(narrowed, async () => {
      await rejectsWith(svc.updateProjectLink(OWN_C, foreignLink._id.toString(), { notes: 'x' }), 403);
      await rejectsWith(svc.deleteProjectLink(OWN_C, foreignLink._id.toString()), 403);
      await svc.findProjectLinks(OWN_C);
      await svc.findLinksByProject(OWN_P);
    });
    assert.deepEqual(writes, []);
    assert.ok(JSON.stringify(finds[0].projectId).includes(OWN_P), 'findProjectLinks not filtered by project');
    assert.ok(finds[0].customerId, 'customer filter kept');
    assert.ok(JSON.stringify(finds[1].customerId).includes(OWN_C), 'findLinksByProject not filtered by customer');
    // internal caller still mutates
    await svc.deleteProjectLink(OWN_C, foreignLink._id.toString());
    assert.deepEqual(writes, ['delete']);
  });

  // ---------------------------------------------------------------- stacks / templates
  await check('Stacks: writes need admin (service level, covers MCP), reads open', async () => {
    const stack = { _id: oid(), name: 's', entries: Object.assign([], { id: () => null, pull() {} }), save: async () => {} };
    const model = { ...mapModel([stack]), find: () => q([]) };
    const svc = new StacksService(model);
    await as(narrowed, async () => {
      await rejectsWith(svc.create({ name: 'x' }), 403);
      await rejectsWith(svc.update(stack._id.toString(), { name: 'x' }), 403);
      await rejectsWith(svc.remove(stack._id.toString()), 403);
      await rejectsWith(svc.addEntry(stack._id.toString(), { title: 't' }), 403);
      await rejectsWith(svc.updateEntry(stack._id.toString(), 'e', {}), 403);
      await rejectsWith(svc.removeEntry(stack._id.toString(), 'e'), 403);
      await rejectsWith(svc.reorderEntries(stack._id.toString(), []), 403);
      await svc.findAll();
      await svc.findById(stack._id.toString());
    });
    await as(admin, () => svc.create({ name: 'ok' }));
    await svc.create({ name: 'internal' });
  });

  await check('Customer templates: create/update/delete need admin, list/get open', async () => {
    const tpl = { _id: oid(), name: 't', items: [], version: 1, save: async function () { return this; }, deleteOne: async () => {} };
    const model = { ...mapModel([tpl]), find: () => q([tpl]) };
    const svc = new CustomerTemplatesService(model, {}, {}, {}, {}, {}, customersFake, events);
    await as(narrowed, async () => {
      await rejectsWith(svc.create({ name: 'x', slug: 'x', type: 'onboarding' }), 403);
      await rejectsWith(svc.update(tpl._id.toString(), { name: 'x' }), 403);
      await rejectsWith(svc.remove(tpl._id.toString()), 403);
      assert.equal((await svc.list({})).length, 1);
      assert.equal((await svc.findById(tpl._id.toString())).name, 't');
    });
    await as(admin, () => svc.update(tpl._id.toString(), { name: 'renamed' }));
    assert.equal(tpl.name, 'renamed');
  });

  // ---------------------------------------------------------------- outbound guard
  const DNS = { minio: ['172.20.0.7'], 'files.internal': ['172.20.0.8'], 'host.docker.internal': ['172.17.0.1'], 'public.test': ['93.184.216.34'] };
  const makeGuard = (env = {}, gateways = ['172.20.0.1']) => createOutboundGuard({
    lookup: async (host) => {
      const hit = DNS[host];
      if (!hit) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return hit.map((address) => ({ address, family: 4 }));
    },
    interfaceAddresses: () => ['127.0.0.1'],
    env,
    now: () => 0,
    gatewayAddresses: () => gateways,
  });
  const blocked = (p) => assert.rejects(p, (e) => e instanceof OutboundBlockedException && e.reason === 'instance');

  await check('Outbound guard: minio, MINIO_ENDPOINT host and the default gateway are instance services', async () => {
    const guard = makeGuard({ MINIO_ENDPOINT: 'files.internal:9000' });
    await blocked(guard.resolve('minio'));
    await blocked(guard.resolve('172.20.0.7'));
    await blocked(guard.resolve('files.internal'));
    await blocked(guard.resolve('172.20.0.1'));
    await blocked(guard.resolve('host.docker.internal'));
    assert.equal((await guard.resolve('public.test')).address, '93.184.216.34');
    // a throwing gateway reader is best-effort, not fatal
    const g2 = createOutboundGuard({
      lookup: async (h) => { if (h !== 'public.test') throw new Error('ENOTFOUND'); return [{ address: '93.184.216.34', family: 4 }]; }, interfaceAddresses: () => [], env: {}, now: () => 0,
      gatewayAddresses: () => { throw new Error('no /proc'); },
    });
    assert.equal((await g2.resolve('public.test')).address, '93.184.216.34');
  });

  await check('Outbound guard: OUTBOUND_ALLOW_HOSTS exempts the gateway and minio', async () => {
    const guard = makeGuard({ OUTBOUND_ALLOW_HOSTS: '172.20.0.1,minio' });
    assert.equal((await guard.resolve('172.20.0.1')).address, '172.20.0.1');
    assert.equal((await guard.resolve('minio')).address, 'minio');
  });

  await check('parseProcNetRoute: default route gateway, little-endian hex', async () => {
    const text = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'eth0\t00000000\t010014AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
      'eth0\t000014AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    ].join('\n');
    assert.deepEqual(parseProcNetRoute(text), ['172.20.0.1']);
    assert.deepEqual(parseProcNetRoute(''), []);
  });

  console.log(`\n${total - failures}/${total} checks passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`expected ${EXPECTED_CHECKS} checks, ran ${total}`);
    process.exit(1);
  }
  process.exit(failures ? 1 : 0);
})();
