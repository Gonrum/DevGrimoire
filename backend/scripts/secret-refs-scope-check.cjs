#!/usr/bin/env node
/*
 * Secret-reference scope check (slice `secret-refs`).
 *
 * Background jobs (healthcheck cron, commit cron) resolve stored secret
 * references WITHOUT an actor, so the actor scope check does not run then.
 * This check pins the boundaries that close that gap:
 *   - monitoring secretHeaders: foreign secret rejected on create/update,
 *     and not resolved by buildHeaders without an actor
 *   - git tokenSecretId: foreign secret rejected on project update, not
 *     decrypted by the commit sync without an actor
 *   - allowPrivateHost: admin only (project update, validate-token)
 *   - git target guard resolves DNS (private address / single-label blocked)
 *   - commits / projects read paths scope-checked
 *   - getDecryptedForEnvironment scope-checked
 *   - download ticket: opaque, redeemed as the issuing actor; customer-bound
 *     environments only for linked projects
 *   - internal callers (no actor) still work
 *
 * Loads from dist/; run `npm run build` first.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

process.env.SECRETS_ENCRYPTION_KEY = 'b'.repeat(64);

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { RequestContext } = loadCompiled('common/request-context.js');
const { EncryptionService } = loadCompiled('common/encryption.service.js');
const { SecretsService } = loadCompiled('secrets/secrets.service.js');
const { MonitoringService } = loadCompiled('monitoring/monitoring.service.js');
const { CommitsService } = loadCompiled('commits/commits.service.js');
const { ProjectsService } = loadCompiled('projects/projects.service.js');
const { HttpRequestsService } = loadCompiled('http-requests/http-requests.service.js');
const { HttpRequestsController } = loadCompiled('http-requests/http-requests.controller.js');
const { DownloadTicketService } = loadCompiled('http-requests/download-ticket.service.js');
const { assertGitTarget } = loadCompiled('commits/providers/url-validator.js');
const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const EXPECTED_CHECKS = 18;

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
const admin = { ...narrowed, userId: 'a1', username: 'root', role: 'admin', projectScopeMode: 'all', customerScopeMode: 'all' };
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
    return String(actual) === String(v);
  });
}
function chain(result) {
  const q = { select: () => q, lean: () => q, sort: () => q, limit: () => q, skip: () => q, exec: async () => result() };
  return q;
}
function makeModel(docs) {
  const store = docs.slice();
  return {
    _store: store,
    find: (filter = {}) => chain(() => store.filter((d) => matches(d, filter))),
    findOne: (filter = {}) => chain(() => store.find((d) => matches(d, filter)) ?? null),
    findById: (id) => chain(() => store.find((d) => String(d._id) === String(id)) ?? null),
    exists: (filter) => chain(() => (store.some((d) => matches(d, filter)) ? { _id: 'x' } : null)),
    countDocuments: (filter) => chain(() => store.filter((d) => matches(d, filter)).length),
    create: async (doc) => { const d = { _id: oid(), ...doc }; store.push(d); return d; },
    findByIdAndUpdate: () => chain(() => null),
  };
}

const enc = new EncryptionService();
const OWN_SECRET = oid();
const OWN_CUSTOMER_SECRET = oid();
const FOREIGN_SECRET = oid();
const secretDocs = () => [
  { _id: OWN_SECRET, projectId: OWN_PROJECT, environmentId: null, key: 'OWN', encryptedValue: enc.encrypt('own-value') },
  { _id: OWN_CUSTOMER_SECRET, customerId: OWN_CUSTOMER, environmentId: null, key: 'CUST', encryptedValue: enc.encrypt('cust-value') },
  { _id: FOREIGN_SECRET, projectId: FOREIGN_PROJECT, environmentId: null, key: 'FOREIGN', encryptedValue: enc.encrypt('foreign-token') },
];
const noopEmitter = { emit: () => {} };
const makeSecrets = () => new SecretsService(makeModel(secretDocs()), { findById: async () => ({}) }, enc, noopEmitter);

function makeMonitoring(linkedProjectIds = []) {
  const checkModel = makeModel([]);
  const secrets = makeSecrets();
  const customers = {
    findById: async () => ({}),
    findProjectLinks: async () => linkedProjectIds.map((projectId) => ({ projectId })),
  };
  const svc = new MonitoringService(
    checkModel, makeModel([]), customers, secrets, { create: async () => {} }, noopEmitter,
  );
  return { svc, checkModel };
}

function makeProjects(projects = []) {
  const projectModel = makeModel(projects);
  const linkModel = makeModel([{ _id: oid(), projectId: OWN_PROJECT, customerId: OWN_CUSTOMER }]);
  return new ProjectsService(projectModel, linkModel, noopEmitter, {}, makeModel(secretDocs()));
}

(async () => {
  // ---- monitoring --------------------------------------------------------
  await check('monitoring create rejects a foreign secretHeaders secret (403) and writes nothing', async () => {
    const { svc, checkModel } = makeMonitoring();
    await asActor(narrowed, () => rejectsWith(svc.create({
      customerId: String(OWN_CUSTOMER), name: 'hc', url: 'https://example.test',
      secretHeaders: [{ name: 'Authorization', secretId: String(FOREIGN_SECRET) }],
    }), 403));
    assert.equal(checkModel._store.length, 0);
  });

  await check('monitoring create accepts own customer and own project secret', async () => {
    const { svc, checkModel } = makeMonitoring();
    await asActor(narrowed, () => svc.create({
      customerId: String(OWN_CUSTOMER), projectId: String(OWN_PROJECT), name: 'hc', url: 'https://example.test',
      secretHeaders: [
        { name: 'X-A', secretId: String(OWN_CUSTOMER_SECRET) },
        { name: 'X-B', secretId: String(OWN_SECRET) },
      ],
    }));
    assert.equal(checkModel._store.length, 1);
  });

  // Regression: the UI offers project secrets of every project linked to the
  // check's customer, also for a check without projectId. Rejecting those made
  // existing checks lose their headers and impossible to save.
  await check('monitoring accepts a project secret of a project linked to the customer', async () => {
    const { svc, checkModel } = makeMonitoring([OWN_PROJECT]);
    await asActor(narrowed, () => svc.create({
      customerId: String(OWN_CUSTOMER), name: 'hc', url: 'https://example.test',
      secretHeaders: [{ name: 'X-B', secretId: String(OWN_SECRET) }],
    }));
    assert.equal(checkModel._store.length, 1);
    // …but not one of an unlinked project, even when the actor could see it.
    const unlinked = makeMonitoring([]);
    await asActor(narrowed, () => rejectsWith(unlinked.svc.create({
      customerId: String(OWN_CUSTOMER), name: 'hc', url: 'https://example.test',
      secretHeaders: [{ name: 'X-B', secretId: String(OWN_SECRET) }],
    }), 403));
  });

  await check('monitoring create rejects a check for a foreign project (403)', async () => {
    const { svc } = makeMonitoring();
    await asActor(narrowed, () => rejectsWith(svc.create({
      customerId: String(OWN_CUSTOMER), projectId: String(FOREIGN_PROJECT), name: 'hc', url: 'https://example.test',
    }), 403));
  });

  await check('buildHeaders without actor (cron) does not resolve a foreign secret, own one is resolved', async () => {
    const { svc } = makeMonitoring();
    const headers = await svc.buildHeaders({
      _id: oid(), customerId: OWN_CUSTOMER, headers: [],
      secretHeaders: [
        { name: 'X-Own', secretId: OWN_CUSTOMER_SECRET },
        { name: 'X-Stolen', secretId: FOREIGN_SECRET },
      ],
    });
    assert.equal(headers['X-Own'], 'cust-value');
    assert.equal(headers['X-Stolen'], undefined, 'foreign secret was decrypted into a header');
  });

  // ---- secrets -----------------------------------------------------------
  await check('getDecryptedForEnvironment rejects a foreign project (403), internal call works', async () => {
    const secrets = makeSecrets();
    await asActor(narrowed, () => rejectsWith(secrets.getDecryptedForEnvironment({ projectId: String(FOREIGN_PROJECT) }, ''), 403));
    const internal = await secrets.getDecryptedForEnvironment({ projectId: String(FOREIGN_PROJECT) }, '');
    assert.deepEqual(internal.map((s) => s.value), ['foreign-token']);
  });

  await check('secret create (upsert) into a foreign project is rejected (403)', async () => {
    const secrets = makeSecrets();
    await asActor(narrowed, () => rejectsWith(secrets.create({ projectId: String(FOREIGN_PROJECT), key: 'X', value: 'v' }), 403));
  });

  // ---- commits -----------------------------------------------------------
  function makeCommits(tokenSecretId) {
    const project = {
      _id: OWN_PROJECT,
      toObject: () => ({ gitRepositories: [{ provider: 'github', tokenSecretId: String(tokenSecretId), syncEnabled: true }] }),
    };
    const sent = [];
    const registry = { get: () => ({ fetchCommits: async (_cfg, token) => { sent.push(token); return { commits: [] }; } }) };
    const projects = { findById: async () => project, updateRaw: async () => project };
    const svc = new CommitsService(makeModel([{ _id: oid(), projectId: FOREIGN_PROJECT, sha: 'abc' }]), noopEmitter, registry, makeSecrets(), projects);
    return { svc, sent };
  }

  await check('commit sync without actor refuses a foreign tokenSecretId (token never sent)', async () => {
    const { svc, sent } = makeCommits(FOREIGN_SECRET);
    await rejectsWith(svc.syncRepository(String(OWN_PROJECT), 0), 403);
    assert.deepEqual(sent, []);
  });

  await check('commit sync without actor uses the project\'s own token', async () => {
    const { svc, sent } = makeCommits(OWN_SECRET);
    await svc.syncRepository(String(OWN_PROJECT), 0);
    assert.deepEqual(sent, ['own-value']);
  });

  await check('commit read paths reject a foreign project (403)', async () => {
    const { svc } = makeCommits(OWN_SECRET);
    await asActor(narrowed, async () => {
      await rejectsWith(svc.findByProject(String(FOREIGN_PROJECT)), 403);
      await rejectsWith(svc.search(String(FOREIGN_PROJECT), 'x'), 403);
      await rejectsWith(svc.countByProject(String(FOREIGN_PROJECT)), 403);
    });
  });

  await check('validate-token with allowPrivateHost needs admin', async () => {
    const { svc } = makeCommits(OWN_SECRET);
    await asActor(narrowed, () => rejectsWith(svc.validateRepoToken({ provider: 'github', allowPrivateHost: true }, 't'), 403));
  });

  // ---- projects ----------------------------------------------------------
  await check('project update rejects a foreign tokenSecretId (403)', async () => {
    const projects = makeProjects([{ _id: OWN_PROJECT, name: 'own', gitRepositories: [] }]);
    await asActor(narrowed, () => rejectsWith(projects.update(String(OWN_PROJECT), {
      gitRepositories: [{ provider: 'github', tokenSecretId: String(FOREIGN_SECRET) }],
    }), 403));
    // Own token passes validation.
    await asActor(narrowed, () => projects.assertGitRepositoriesAllowed(String(OWN_PROJECT), [{ tokenSecretId: String(OWN_SECRET) }]));
  });

  await check('allowPrivateHost on a new baseUrl: non-admin 403, admin ok, existing grant kept', async () => {
    const projects = makeProjects([{
      _id: OWN_PROJECT, name: 'own',
      gitRepositories: [{ baseUrl: 'http://gitea:3000', allowPrivateHost: true }],
    }]);
    const id = String(OWN_PROJECT);
    await asActor(narrowed, () => rejectsWith(
      projects.assertGitRepositoriesAllowed(id, [{ baseUrl: 'http://10.0.0.9', allowPrivateHost: true }]), 403));
    await asActor(admin, () => projects.assertGitRepositoriesAllowed(id, [{ baseUrl: 'http://10.0.0.9', allowPrivateHost: true }]));
    await asActor(narrowed, () => projects.assertGitRepositoriesAllowed(id, [{ baseUrl: 'http://gitea:3000', allowPrivateHost: true }]));
  });

  await check('findByName on a foreign project 403; findAll with a foreign customerId 403', async () => {
    const projects = makeProjects([{ _id: FOREIGN_PROJECT, name: 'foreign' }]);
    await asActor(narrowed, async () => {
      await rejectsWith(projects.findByName('foreign'), 403);
      await rejectsWith(projects.findAll(undefined, undefined, String(FOREIGN_CUSTOMER)), 403);
      assert.equal(await projects.nameExists('foreign'), true);
    });
  });

  // ---- git target guard --------------------------------------------------
  await check('git target guard resolves DNS: private address and single-label host blocked', async () => {
    const deps = (addr) => ({ lookup: async () => [{ address: addr }], guard: { assertUrl: async () => ({ address: addr, family: 4 }) } });
    await rejectsWith(assertGitTarget(new URL('https://git.example.com'), false, deps('10.1.2.3')), 400);
    await rejectsWith(assertGitTarget(new URL('http://gitea:3000'), false, deps('172.18.0.5')), 400);
    await assertGitTarget(new URL('https://git.example.com'), false, deps('203.0.113.7'));
    await assertGitTarget(new URL('https://git.example.com'), true, deps('10.1.2.3'));
  });

  // ---- http requests -----------------------------------------------------
  await check('download ticket is opaque and redemption runs as the issuing actor', async () => {
    const tickets = new DownloadTicketService();
    const REQ = String(oid());
    let seenActor = 'unset';
    const svc = {
      assertDownloadAllowed: async () => {},
      openStream: async () => {
        seenActor = RequestContext.getUser();
        return { upstream: { status: 200, headers: { get: () => null } }, body: null, filename: 'f' };
      },
    };
    const ctrl = new HttpRequestsController(svc, tickets);
    const { ticket } = await asActor(narrowed, () => ctrl.downloadTicket(REQ, {}));
    assert.ok(!ticket.includes(':'), 'ticket looks like an encrypted payload');
    const res = { status() { return res; }, setHeader() {}, end() {}, json() {}, headersSent: false };
    await ctrl.download(REQ, ticket, res); // public route: no actor in context
    assert.equal(seenActor && seenActor.userId, 'u1', 'openStream did not run as the issuing actor');
  });

  await check('customer-bound environment only for a project linked to that customer', async () => {
    const projects = makeProjects([]);
    const ENV_FOREIGN_CUST = oid();
    const ENV_OWN_CUST = oid();
    const envs = {
      findById: async (id) => (String(id) === String(ENV_OWN_CUST)
        ? { _id: ENV_OWN_CUST, customerId: OWN_CUSTOMER, variables: [] }
        : { _id: ENV_FOREIGN_CUST, customerId: FOREIGN_CUSTOMER, variables: [] }),
    };
    const REQ = oid();
    const requestModel = makeModel([{ _id: REQ, projectId: OWN_PROJECT, name: 'r', method: 'GET', url: 'https://x.test' }]);
    const svc = new HttpRequestsService(makeModel([]), requestModel, makeModel([]), makeSecrets(), envs, projects);
    await rejectsWith(svc.assertDownloadAllowed(String(REQ), String(ENV_FOREIGN_CUST)), 400);
    await svc.assertDownloadAllowed(String(REQ), String(ENV_OWN_CUST));
  });

  await check('internal caller (no actor) still reads commits and projects', async () => {
    const { svc } = makeCommits(OWN_SECRET);
    const rows = await svc.findByProject(String(FOREIGN_PROJECT));
    assert.equal(rows.length, 1);
    const projects = makeProjects([{ _id: FOREIGN_PROJECT, name: 'foreign' }]);
    assert.ok(await projects.findByName('foreign'));
  });

  console.log(`\n${total - failures}/${total} checks passed.`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`expected ${EXPECTED_CHECKS} checks, ran ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
