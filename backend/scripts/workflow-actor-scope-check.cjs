#!/usr/bin/env node
/**
 * T-505: Definitionen und Läufe prüfen den Scope des Request-Akteurs.
 *
 * Vorher galt die Prüfung nur für Start, Retry, Aktivierung und Node-Test.
 * Lesen, Anlegen, Ändern, Löschen einer Definition und das Lesen/Abbrechen
 * von Läufen waren für einen auf Projekt A verengten API-Key in Projekt B
 * offen.
 *
 * Läuft gegen `dist/` mit Modell-Attrappen, ohne Nest und ohne MongoDB.
 * Nach `npm run build` ausführen.
 */
const assert = require('node:assert/strict');

const { WorkflowsService } = require('../dist/workflows/workflows.service');
const { RequestContext } = require('../dist/common/request-context');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

const PROJ_A = '64b00000000000000000a001';
const PROJ_B = '64b00000000000000000b002';
const CUST_A = '64b00000000000000000ca01';
const CUST_B = '64b00000000000000000cb02';
const DEF_A = '64b0000000000000000d0a01';
const DEF_B = '64b0000000000000000d0b02';
const DEF_CB = '64b0000000000000000d0c03';
const DEF_SYS = '64b0000000000000000d0d04';
const RUN_A = '64b0000000000000000e0a01';
const RUN_B = '64b0000000000000000e0b02';
const NR_A = '64b0000000000000000f0a01';
const NR_B = '64b0000000000000000f0b02';

function oid(hex) {
  return { toString: () => hex, equals: (o) => String(o) === hex };
}

/** Auf Projekt A und Kunde A verengter Key. */
const narrowed = {
  userId: '64b000000000000000000a0a', username: 'a', role: 'user', apiKeyId: '64b0000000000000000aaa01',
  projectScopeMode: 'allowlist', allowedProjectIds: [PROJ_A],
  customerScopeMode: 'allowlist', allowedCustomerIds: [CUST_A],
};
/** Admin ohne Verengung. */
const admin = { userId: '64b000000000000000000b0b', username: 'admin', role: 'admin' };

const as = (actor, fn) => RequestContext.run(actor, undefined, fn);
const forbidden = (e) => e.status === 403;

function def(id, owner, extra = {}) {
  const doc = {
    _id: oid(id), name: `w-${id.slice(-4)}`, status: 'draft', version: 1, nodes: [], edges: [], approvals: [],
    scope: owner.projectId ? 'project' : owner.customerId ? 'customer' : 'system',
    projectId: owner.projectId ? oid(owner.projectId) : undefined,
    customerId: owner.customerId ? oid(owner.customerId) : undefined,
    ...extra,
  };
  doc.save = async () => { world.saved.push(id); return doc; };
  doc.deleteOne = async () => { world.deleted.push(id); };
  return doc;
}

let world;
function fresh() {
  world = { created: [], saved: [], deleted: [], deleteMany: [], findFilters: [], cancelled: [] };
  const defs = [
    def(DEF_A, { projectId: PROJ_A }),
    def(DEF_B, { projectId: PROJ_B }),
    def(DEF_CB, { customerId: CUST_B }),
    def(DEF_SYS, {}),
  ];
  const runs = [
    { _id: oid(RUN_A), definitionId: oid(DEF_A), scope: 'project', projectId: oid(PROJ_A), status: 'running' },
    { _id: oid(RUN_B), definitionId: oid(DEF_B), scope: 'project', projectId: oid(PROJ_B), status: 'running' },
  ];
  const nodeRuns = [
    { _id: oid(NR_A), runId: oid(RUN_A), nodeId: 'n', status: 'succeeded' },
    { _id: oid(NR_B), runId: oid(RUN_B), nodeId: 'n', status: 'succeeded' },
  ];
  const byId = (list) => (id) => ({ exec: async () => list.find((d) => d._id.toString() === String(id)) ?? null });
  const findChain = (list, label) => (filter) => {
    world.findFilters.push({ label, filter });
    const q = { sort: () => q, limit: () => q, skip: () => q, select: () => q, lean: () => q, exec: async () => list };
    return q;
  };
  const Def = {
    findById: byId(defs),
    find: findChain(defs, 'def'),
    create: async (doc) => { world.created.push(doc); return { _id: oid('new'), ...doc }; },
  };
  const Run = {
    findById: (id) => {
      const doc = runs.find((d) => d._id.toString() === String(id)) ?? null;
      const q = { select: () => q, lean: () => q, exec: async () => doc };
      return q;
    },
    find: findChain(runs, 'run'),
    findOneAndUpdate: (filter) => ({
      exec: async () => { world.cancelled.push(filter._id.toString()); return { ...runs.find((r) => r._id === filter._id), status: 'cancelled' }; },
    }),
    deleteMany: (f) => ({ exec: async () => { world.deleteMany.push(f); } }),
    create: async (doc) => { world.created.push(doc); return { _id: oid('run'), ...doc }; },
  };
  const NodeRun = {
    findById: byId(nodeRuns),
    find: (filter) => {
      const q = { sort: () => q, exec: async () => nodeRuns.filter((n) => n.runId.toString() === filter.runId.toString()) };
      return q;
    },
    updateMany: () => ({ exec: async () => ({}) }),
    deleteMany: (f) => ({ exec: async () => { world.deleteMany.push(f); } }),
  };
  const secrets = { available: async () => [] };
  return new WorkflowsService(Def, Run, NodeRun, { emit: () => true }, { has: () => false }, { record: async () => {} }, secrets);
}

/** Der Filter, den `find` zuletzt für `label` bekommen hat. */
function lastFilter(label) {
  const hit = [...world.findFilters].reverse().find((f) => f.label === label);
  assert.ok(hit, `find(${label}) wurde nicht aufgerufen`);
  return hit.filter;
}

/** Ids, die der Scope-Teil eines Filters auf `axisField` zulässt (als Strings). */
function allowedIds(filter, axisField) {
  const clauses = filter.$and ?? [];
  const clause = clauses.find((c) => c.$or && c.$or.some((o) => axisField in o));
  if (!clause) return null;
  const inPart = clause.$or.find((o) => o[axisField] && o[axisField].$in)[axisField].$in;
  return [...new Set(inPart.map(String))];
}

(async () => {
  // ---- Definitionen -----------------------------------------------------
  await check('create: fremdes Projekt → 403, nichts angelegt', async () => {
    const svc = fresh();
    await assert.rejects(as(narrowed, () => svc.createDefinition({ scope: 'project', projectId: PROJ_B, name: 'x' })), forbidden);
    await assert.rejects(as(narrowed, () => svc.createDefinition({ scope: 'customer', customerId: CUST_B, name: 'x' })), forbidden);
    assert.equal(world.created.length, 0);
  });

  await check('create: eigenes Projekt, Admin und interner Aufruf (ohne Akteur) gehen durch', async () => {
    const svc = fresh();
    await as(narrowed, () => svc.createDefinition({ scope: 'project', projectId: PROJ_A, name: 'x' }));
    await as(admin, () => svc.createDefinition({ scope: 'project', projectId: PROJ_B, name: 'x' }));
    await svc.createDefinition({ scope: 'project', projectId: PROJ_B, name: 'x' });
    assert.equal(world.created.length, 3);
  });

  await check('create über Template: fremdes Projekt → 403', async () => {
    const svc = fresh();
    const { listTemplatesPublic } = require('../dist/workflows/workflow-templates');
    const tpl = listTemplatesPublic().find((t) => t.supportedScopes.includes('project'));
    assert.ok(tpl, 'kein Template mit project-Scope gefunden');
    await assert.rejects(
      as(narrowed, () => svc.instantiateTemplate({ templateId: tpl.id, name: 'x', scope: 'project', projectId: PROJ_B })),
      forbidden,
    );
    assert.equal(world.created.length, 0);
  });

  await check('get: fremdes Projekt/fremder Kunde → 403, eigenes und System-Workflow → ok', async () => {
    const svc = fresh();
    await assert.rejects(as(narrowed, () => svc.getDefinition(DEF_B)), forbidden);
    await assert.rejects(as(narrowed, () => svc.getDefinition(DEF_CB)), forbidden);
    assert.equal((await as(narrowed, () => svc.getDefinition(DEF_A)))._id.toString(), DEF_A);
    assert.equal((await as(narrowed, () => svc.getDefinition(DEF_SYS)))._id.toString(), DEF_SYS);
    assert.equal((await as(admin, () => svc.getDefinition(DEF_B)))._id.toString(), DEF_B);
    assert.equal((await svc.getDefinition(DEF_B))._id.toString(), DEF_B);
  });

  await check('get: ungültige Id bleibt 400, unbekannte 404 (vor der Scope-Prüfung)', async () => {
    const svc = fresh();
    await assert.rejects(as(narrowed, () => svc.getDefinition('kaputt')), (e) => e.status === 400);
    await assert.rejects(as(narrowed, () => svc.getDefinition('64b0000000000000000d0fff')), (e) => e.status === 404);
  });

  await check('update: fremdes Projekt → 403, nichts gespeichert', async () => {
    const svc = fresh();
    await assert.rejects(as(narrowed, () => svc.updateDefinition(DEF_B, { name: 'übernommen' })), forbidden);
    assert.deepEqual(world.saved, []);
    await as(narrowed, () => svc.updateDefinition(DEF_A, { name: 'ok' }));
    assert.deepEqual(world.saved, [DEF_A]);
  });

  await check('delete: fremdes Projekt → 403, keine Läufe und keine Definition gelöscht', async () => {
    const svc = fresh();
    await assert.rejects(as(narrowed, () => svc.deleteDefinition(DEF_B)), forbidden);
    assert.deepEqual(world.deleted, []);
    assert.deepEqual(world.deleteMany, []);
    await as(narrowed, () => svc.deleteDefinition(DEF_A));
    assert.deepEqual(world.deleted, [DEF_A]);
  });

  await check('listAvailableSecrets: fremdes Projekt → 403', async () => {
    const svc = fresh();
    await assert.rejects(as(narrowed, () => svc.listAvailableSecrets(DEF_B)), forbidden);
    await as(narrowed, () => svc.listAvailableSecrets(DEF_A));
  });

  await check('list: verengter Key filtert auf seine Projekte und Kunden, System bleibt sichtbar', async () => {
    const svc = fresh();
    await as(narrowed, () => svc.listDefinitions({}));
    const f = lastFilter('def');
    assert.deepEqual(allowedIds(f, 'projectId'), [PROJ_A]);
    assert.deepEqual(allowedIds(f, 'customerId'), [CUST_A]);
    // Das Fehlen des Felds ist ausdrücklich erlaubt — sonst verschwänden
    // Kunden-Workflows (ohne projectId) und System-Workflows.
    const projClause = f.$and.find((c) => c.$or.some((o) => 'projectId' in o));
    assert.ok(projClause.$or.some((o) => o.projectId && o.projectId.$exists === false));
    // Der Status-Filter (Archiv ausblenden) bleibt erhalten.
    assert.deepEqual(f.status, { $ne: 'archived' });
  });

  await check('list: explizite projectId-Abfrage eines fremden Projekts bleibt durch den Scope begrenzt', async () => {
    const svc = fresh();
    await as(narrowed, () => svc.listDefinitions({ projectId: PROJ_B }));
    const f = lastFilter('def');
    assert.equal(String(f.projectId), PROJ_B);
    assert.deepEqual(allowedIds(f, 'projectId'), [PROJ_A]);
  });

  await check('list: unverengter Akteur und interner Aufruf bekommen keinen Scope-Filter', async () => {
    const svc = fresh();
    await as(admin, () => svc.listDefinitions({}));
    assert.equal(lastFilter('def').$and, undefined);
    await svc.listDefinitions({});
    assert.equal(lastFilter('def').$and, undefined);
  });

  await check('list: Scope "none" ergibt einen Filter, der nichts trifft (wie bei Todos/Knowledge)', async () => {
    const svc = fresh();
    await as({ ...narrowed, projectScopeMode: 'none', allowedProjectIds: [] }, () => svc.listDefinitions({}));
    const f = lastFilter('def');
    const projClause = f.$and.find((c) => 'projectId' in c);
    assert.deepEqual(projClause, { projectId: { $in: [] } });
  });

  // ---- Läufe ------------------------------------------------------------
  await check('getRun/inspectRun: fremdes Projekt → 403', async () => {
    const svc = fresh();
    await assert.rejects(as(narrowed, () => svc.getRun(RUN_B)), forbidden);
    await assert.rejects(as(narrowed, () => svc.inspectRun(RUN_B)), forbidden);
    assert.equal((await as(narrowed, () => svc.getRun(RUN_A)))._id.toString(), RUN_A);
    const insp = await as(narrowed, () => svc.inspectRun(RUN_A));
    assert.equal(insp.run.id, RUN_A);
    assert.equal(insp.summary.totalNodeRuns, 1);
  });

  await check('cancelRun: fremdes Projekt → 403, nichts abgebrochen', async () => {
    const svc = fresh();
    await assert.rejects(as(narrowed, () => svc.cancelRun(RUN_B, { reason: 'x' })), forbidden);
    assert.deepEqual(world.cancelled, []);
  });

  await check('listNodeRuns/getNodeRun: fremder Lauf → 403', async () => {
    const svc = fresh();
    await assert.rejects(as(narrowed, () => svc.listNodeRuns(RUN_B)), forbidden);
    await assert.rejects(as(narrowed, () => svc.getNodeRun(NR_B)), forbidden);
    assert.equal((await as(narrowed, () => svc.listNodeRuns(RUN_A))).length, 1);
    assert.equal((await as(narrowed, () => svc.getNodeRun(NR_A)))._id.toString(), NR_A);
  });

  await check('listRuns: verengter Key filtert, unverengter nicht', async () => {
    const svc = fresh();
    await as(narrowed, () => svc.listRuns({}));
    assert.deepEqual(allowedIds(lastFilter('run'), 'projectId'), [PROJ_A]);
    await as(admin, () => svc.listRuns({}));
    assert.equal(lastFilter('run').$and, undefined);
  });

  // ---- Bestehende Ausnahmen dürfen nicht kippen -------------------------
  await check('startRun per Event im RequestContext eines verengten Auslösers bleibt erlaubt', async () => {
    const svc = fresh();
    const active = { status: 'active' };
    Object.assign((await svc.getDefinition(DEF_B)), active);
    await as(narrowed, () => svc.startRun({ definitionId: DEF_B, triggeredBy: { type: 'event' } }));
    assert.equal(world.created.length, 1);
  });

  await check('cancelIdleDebugRuns ohne Akteur läuft weiter (Scheduler)', async () => {
    const svc = fresh();
    // Run.find liefert beide Läufe; ohne Akteur darf cancelRun beide treffen.
    const n = await svc.cancelIdleDebugRuns(new Date());
    assert.equal(n, 2);
  });

  console.log(`${passed} passed`);
})();
