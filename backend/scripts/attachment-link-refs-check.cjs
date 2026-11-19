#!/usr/bin/env node
/*
 * Attachment link + customer-project link reference check.
 *
 * Stored references must point into the same owner, otherwise a narrowed
 * actor can hook its own data onto a foreign entity:
 *   - attachments: entityType/entityId must name an existing todo/knowledge
 *     of the attachment's owner, in the actor's scope (create + update);
 *     unknown types and invalid ids are rejected, nothing hits MinIO first
 *   - customer-project links: every environmentId must belong to the linked
 *     project or customer (create + update); a stored id whose environment
 *     was deleted is dropped instead of making the link unsavable
 *   - the owner rule also holds for internal callers (no actor)
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
const { AttachmentsService } = loadCompiled('attachments/attachments.service.js');
const { CustomersService } = loadCompiled('customers/customers.service.js');
const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const EXPECTED_CHECKS = 10;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const statusOf = (e) => (e && typeof e.getStatus === 'function' ? e.getStatus() : undefined);
const rejectsWith = async (promise, status) => {
  const err = await promise.then(() => null, (e) => e);
  assert.ok(err, `expected HTTP ${status}, call succeeded`);
  assert.equal(statusOf(err), status, `expected HTTP ${status}, got ${statusOf(err)}: ${err.message}`);
  return err;
};

const { Types } = mongoose;
const oid = () => new Types.ObjectId();
const OWN_PROJECT = oid();
const FOREIGN_PROJECT = oid();
const OWN_CUSTOMER = oid();
const FOREIGN_CUSTOMER = oid();

const narrowed = {
  userId: 'u1', username: 'alice', role: 'user',
  projectScopeMode: 'allowlist', allowedProjectIds: [String(OWN_PROJECT)],
  customerScopeMode: 'allowlist', allowedCustomerIds: [String(OWN_CUSTOMER)],
};
const asActor = (actor, fn) => RequestContext.run(actor, undefined, fn);

// ---- in-memory model ---------------------------------------------------
function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$or') return v.some((f) => matches(doc, f));
    const actual = doc[k];
    if (v && typeof v === 'object' && !(v instanceof Types.ObjectId) && Array.isArray(v.$in)) {
      return v.$in.map(String).includes(String(actual));
    }
    if (v === null) return actual === null || actual === undefined;
    if (actual === undefined || actual === null) return false;
    return String(actual) === String(v);
  });
}
function chain(result) {
  const q = { select: () => q, lean: () => q, sort: () => q, limit: () => q, skip: () => q, exec: async () => result() };
  return q;
}
function makeModel(docs) {
  const store = docs.slice();
  const model = {
    _store: store,
    _writes: 0,
    find: (filter = {}) => chain(() => store.filter((d) => matches(d, filter))),
    findOne: (filter = {}) => chain(() => store.find((d) => matches(d, filter)) ?? null),
    findById: (id) => chain(() => store.find((d) => String(d._id) === String(id)) ?? null),
    create: async (doc) => { model._writes += 1; const d = { _id: oid(), ...doc }; store.push(d); return d; },
    findByIdAndUpdate: (id, update) => chain(() => {
      model._writes += 1;
      const d = store.find((x) => String(x._id) === String(id));
      if (d) Object.assign(d, update);
      return d ?? null;
    }),
    findOneAndUpdate: (filter, update) => chain(() => {
      model._writes += 1;
      const d = store.find((x) => matches(x, filter));
      if (d) Object.assign(d, update);
      return d ?? null;
    }),
  };
  return model;
}

const noopEmitter = { emit: () => {} };

// ---- attachments -------------------------------------------------------
const OWN_TODO = oid();
const FOREIGN_TODO = oid();
const OWN_TODO_FOREIGN_CUSTOMER = oid();
const OWN_KNOWLEDGE = oid();
const CUSTOMER_TODO = oid();
const todoDocs = () => [
  { _id: OWN_TODO, projectId: OWN_PROJECT },
  { _id: FOREIGN_TODO, projectId: FOREIGN_PROJECT },
  { _id: OWN_TODO_FOREIGN_CUSTOMER, projectId: OWN_PROJECT, customerId: FOREIGN_CUSTOMER },
  { _id: CUSTOMER_TODO, customerId: OWN_CUSTOMER },
];

function makeAttachments(attachments = []) {
  const attachmentModel = makeModel(attachments);
  const minio = { puts: 0, putObject: async () => { minio.puts += 1; } };
  const svc = new AttachmentsService(
    attachmentModel, minio, { findById: async () => ({}) }, noopEmitter,
    makeModel(todoDocs()), makeModel([{ _id: OWN_KNOWLEDGE, projectId: OWN_PROJECT }]),
  );
  return { svc, attachmentModel, minio };
}
const file = () => ({ buffer: Buffer.from('hello'), originalname: 'a.bin', mimetype: 'application/octet-stream' });

// ---- customers ---------------------------------------------------------
const ENV_OWN_PROJECT = oid();
const ENV_OWN_CUSTOMER = oid();
const ENV_FOREIGN = oid();
const envDocs = () => [
  { _id: ENV_OWN_PROJECT, projectId: OWN_PROJECT },
  { _id: ENV_OWN_CUSTOMER, customerId: OWN_CUSTOMER },
  { _id: ENV_FOREIGN, projectId: FOREIGN_PROJECT },
];

function makeCustomers(links = []) {
  const customerModel = makeModel([{ _id: OWN_CUSTOMER, name: 'own' }]);
  const linkModel = makeModel(links);
  const projects = { findById: async (id) => ({ _id: new Types.ObjectId(String(id)), name: 'p' }) };
  const svc = new CustomersService(customerModel, linkModel, makeModel([]), projects, noopEmitter, makeModel(envDocs()));
  return { svc, linkModel };
}

(async () => {
  await check('attachment upload linked to a foreign project\'s todo: 400, nothing stored', async () => {
    const { svc, attachmentModel, minio } = makeAttachments();
    await asActor(narrowed, () => rejectsWith(svc.create(
      { projectId: String(OWN_PROJECT), entityType: 'todo', entityId: String(FOREIGN_TODO) }, file()), 400));
    // Same for an internal caller: the owner rule is data integrity, not scope.
    await rejectsWith(svc.create(
      { projectId: String(OWN_PROJECT), entityType: 'todo', entityId: String(FOREIGN_TODO) }, file()), 400);
    assert.equal(minio.puts, 0, 'an object was stored for a rejected link');
    assert.equal(attachmentModel._writes, 0);
  });

  await check('attachment upload linked to own todo / own knowledge / own customer todo works', async () => {
    const { svc, attachmentModel } = makeAttachments();
    await asActor(narrowed, async () => {
      await svc.create({ projectId: String(OWN_PROJECT), entityType: 'todo', entityId: String(OWN_TODO) }, file());
      await svc.create({ projectId: String(OWN_PROJECT), entityType: 'knowledge', entityId: String(OWN_KNOWLEDGE) }, file());
      await svc.create({ customerId: String(OWN_CUSTOMER), entityType: 'todo', entityId: String(CUSTOMER_TODO) }, file());
      await svc.create({ projectId: String(OWN_PROJECT) }, file());
    });
    assert.equal(attachmentModel._store.length, 4);
  });

  await check('attachment link to a todo whose second axis is out of scope: 403', async () => {
    const { svc, minio } = makeAttachments();
    await asActor(narrowed, () => rejectsWith(svc.create(
      { projectId: String(OWN_PROJECT), entityType: 'todo', entityId: String(OWN_TODO_FOREIGN_CUSTOMER) }, file()), 403));
    assert.equal(minio.puts, 0);
  });

  await check('attachment link: unknown entityType, invalid entityId, missing entityType are 400', async () => {
    const { svc, minio } = makeAttachments();
    await asActor(narrowed, async () => {
      await rejectsWith(svc.create({ projectId: String(OWN_PROJECT), entityType: 'secret', entityId: String(OWN_TODO) }, file()), 400);
      await rejectsWith(svc.create({ projectId: String(OWN_PROJECT), entityType: 'todo', entityId: '{"$ne":null}' }, file()), 400);
      await rejectsWith(svc.create({ projectId: String(OWN_PROJECT), entityId: String(OWN_TODO) }, file()), 400);
      await rejectsWith(svc.createFromBase64(
        { projectId: String(OWN_PROJECT), fileName: 'a.txt', entityType: 'todo', entityId: String(FOREIGN_TODO) },
        Buffer.from('x').toString('base64')), 400);
    });
    assert.equal(minio.puts, 0);
  });

  await check('attachment update re-targeting to a foreign todo: 400, no write; own todo ok', async () => {
    const ATT = oid();
    const { svc, attachmentModel } = makeAttachments([
      { _id: ATT, projectId: OWN_PROJECT, entityType: 'todo', entityId: OWN_TODO, originalName: 'a', storageKey: 'k' },
    ]);
    await asActor(narrowed, async () => {
      await rejectsWith(svc.update(String(ATT), { entityId: String(FOREIGN_TODO) }), 400);
      await rejectsWith(svc.update(String(ATT), { entityType: 'research' }), 400);
      assert.equal(attachmentModel._writes, 0, 'update wrote despite a rejected link');
      await svc.update(String(ATT), { description: 'no link change' });
      await svc.update(String(ATT), { entityType: 'todo', entityId: String(OWN_TODO) });
    });
    assert.equal(attachmentModel._writes, 2);
  });

  await check('link create with a foreign project\'s environment: 400, nothing created', async () => {
    const { svc, linkModel } = makeCustomers();
    await asActor(narrowed, () => rejectsWith(svc.createProjectLink(String(OWN_CUSTOMER), {
      projectId: String(OWN_PROJECT), environmentIds: [String(ENV_OWN_PROJECT), String(ENV_FOREIGN)],
    }), 400));
    // Internal callers are bound to the same rule.
    await rejectsWith(svc.createProjectLink(String(OWN_CUSTOMER), {
      projectId: String(OWN_PROJECT), environmentIds: [String(ENV_FOREIGN)],
    }), 400);
    assert.equal(linkModel._writes, 0);
  });

  await check('link create with project and customer environments works (deduplicated)', async () => {
    const { svc, linkModel } = makeCustomers();
    const link = await asActor(narrowed, () => svc.createProjectLink(String(OWN_CUSTOMER), {
      projectId: String(OWN_PROJECT),
      environmentIds: [String(ENV_OWN_PROJECT), String(ENV_OWN_CUSTOMER), String(ENV_OWN_PROJECT)],
    }));
    assert.deepEqual(link.environmentIds.map(String), [String(ENV_OWN_PROJECT), String(ENV_OWN_CUSTOMER)]);
    assert.equal(linkModel._writes, 1);
  });

  await check('link create/update with an invalid or unknown environmentId: 400', async () => {
    const LINK = oid();
    const { svc, linkModel } = makeCustomers([
      { _id: LINK, customerId: OWN_CUSTOMER, projectId: OWN_PROJECT, environmentIds: [] },
    ]);
    await asActor(narrowed, async () => {
      await rejectsWith(svc.createProjectLink(String(OWN_CUSTOMER), { projectId: String(OWN_PROJECT), environmentIds: ['nope'] }), 400);
      await rejectsWith(svc.updateProjectLink(String(OWN_CUSTOMER), String(LINK), { environmentIds: [String(oid())] }), 400);
    });
    assert.equal(linkModel._writes, 0);
  });

  await check('link update with a foreign environment: 400, no write; own environments ok', async () => {
    const LINK = oid();
    const { svc, linkModel } = makeCustomers([
      { _id: LINK, customerId: OWN_CUSTOMER, projectId: OWN_PROJECT, environmentIds: [] },
    ]);
    await asActor(narrowed, async () => {
      await rejectsWith(svc.updateProjectLink(String(OWN_CUSTOMER), String(LINK), { environmentIds: [String(ENV_FOREIGN)] }), 400);
      assert.equal(linkModel._writes, 0);
      const link = await svc.updateProjectLink(String(OWN_CUSTOMER), String(LINK), {
        environmentIds: [String(ENV_OWN_PROJECT), String(ENV_OWN_CUSTOMER)],
      });
      assert.equal(link.environmentIds.length, 2);
    });
  });

  await check('link update: stored id of a deleted environment is dropped, stored foreign id still fails', async () => {
    const DELETED_ENV = oid();
    const LINK = oid();
    const { svc } = makeCustomers([
      { _id: LINK, customerId: OWN_CUSTOMER, projectId: OWN_PROJECT, environmentIds: [ENV_OWN_PROJECT, DELETED_ENV, ENV_FOREIGN] },
    ]);
    await asActor(narrowed, async () => {
      // Stored but foreign (legacy data): resubmitting it must not pass.
      await rejectsWith(svc.updateProjectLink(String(OWN_CUSTOMER), String(LINK), {
        environmentIds: [String(ENV_OWN_PROJECT), String(DELETED_ENV), String(ENV_FOREIGN)],
      }), 400);
      const link = await svc.updateProjectLink(String(OWN_CUSTOMER), String(LINK), {
        environmentIds: [String(ENV_OWN_PROJECT), String(DELETED_ENV)],
      });
      assert.deepEqual(link.environmentIds.map(String), [String(ENV_OWN_PROJECT)]);
    });
  });

  console.log(`\n${total - failures}/${total} checks passed.`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`expected ${EXPECTED_CHECKS} checks, ran ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
