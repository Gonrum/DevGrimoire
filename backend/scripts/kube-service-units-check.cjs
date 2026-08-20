#!/usr/bin/env node
/*
 * Pure-logic check für KubeClustersService (K1, Task 3).
 * Mongoose wird durch ein In-Memory-Surrogat ersetzt — wir prüfen
 * Verhalten (Cascade, Rollback, Scope-Filter), keine DB-Integration.
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

const { KubeClustersService } = loadCompiled('kube/kube-clusters.service.js');
const mongoose = loadCompiled('../node_modules/mongoose/index.js');
const { Types } = mongoose;

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  return Promise.resolve().then(fn).then(
    () => console.log(`✓ ${label}`),
    (err) => { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); },
  );
}

function makeModel() {
  const store = new Map();
  const model = {
    _store: store,
    async create(doc) {
      // Emuliert die echten Unique-Indizes aus dem KubeCluster-Schema
      // (customerId+slug / projectId+slug, siehe kube-cluster.schema.ts) —
      // sonst kann kein Check eine ECHTE Duplicate-Slug-Sequenz auslösen,
      // und genau die braucht der Regressionstest für den kritischen
      // Upsert-Kollisions-Bug unten.
      if (typeof doc.slug === 'string') {
        for (const existing of store.values()) {
          if (existing.slug !== doc.slug) continue;
          const sameProject = doc.projectId && existing.projectId
            && String(existing.projectId) === String(doc.projectId);
          const sameCustomer = doc.customerId && existing.customerId
            && String(existing.customerId) === String(doc.customerId);
          if (sameProject || sameCustomer) {
            const dupErr = new Error(
              `E11000 duplicate key error collection: kubeclusters dup key: { slug: "${doc.slug}" }`,
            );
            dupErr.code = 11000;
            throw dupErr;
          }
        }
      }
      const _id = doc._id || new Types.ObjectId();
      // `.save()` fehlte, und deshalb hatte update() — der einzige mutierende
      // Pfad — GAR KEINE Abdeckung: jeder Aufruf scheiterte am fehlenden
      // doc.save(). Dasselbe galt für recordConnectSuccess/-Error.
      const saved = Object.assign({ _id }, doc, {
        async save() { store.set(String(_id), saved); return saved; },
      });
      store.set(String(_id), saved);
      return saved;
    },
    findById(id) { return { exec: async () => store.get(String(id)) || null }; },
    find(filter) {
      return { sort: () => ({ exec: async () => [...store.values()].filter((d) => {
        if (filter.projectId) return String(d.projectId) === String(filter.projectId);
        if (filter.customerId) return String(d.customerId) === String(filter.customerId);
        return true;
      }) }) };
    },
    findOne(filter) { return { exec: async () => [...store.values()].find((d) =>
      d.slug === filter.slug &&
      (filter.projectId ? String(d.projectId) === String(filter.projectId) : true) &&
      (filter.customerId ? String(d.customerId) === String(filter.customerId) : true)) || null }; },
    updateOne(filter, update) { return { exec: async () => {
      const doc = store.get(String(filter._id));
      if (doc && update.$set) Object.assign(doc, update.$set);
      return { modifiedCount: doc ? 1 : 0 };
    } }; },
    deleteOne(filter) { return { exec: async () => { store.delete(String(filter._id)); return { deletedCount: 1 }; } }; },
    deleteMany(filter) { return { exec: async () => {
      const ids = filter._id?.$in || [];
      for (const id of ids) store.delete(String(id));
      return { deletedCount: ids.length };
    } }; },
  };
  return model;
}

/**
 * KubeTransportService-Attrappe. Zeichnet auf, für welche Cluster-Id der
 * Tunnel-Cache verworfen wurde — das ist die Zusicherung aus I2.
 */
function makeTransportStub() {
  const invalidated = [];
  return {
    _invalidated: invalidated,
    invalidate(clusterId) { invalidated.push(String(clusterId)); },
  };
}

function makeSecretsService() {
  // Modelliert das ECHTE Verhalten von SecretsService.create(): kein Insert,
  // sondern findOneAndUpdate({owner, environmentId, key}, ..., {upsert:true})
  // (backend/src/secrets/secrets.service.ts:66-76). Ein zweiter create()-
  // Aufruf mit demselben (Scope, environmentId, Key)-Tripel trifft denselben
  // Datensatz und überschreibt ihn — statt ein neues Secret anzulegen. Das
  // alte Surrogat mintete bei jedem Aufruf eine frische Id und konnte diesen
  // Bug (Task 3, Fix-Runde 1) deshalb nicht abbilden: 13/13 checks passed,
  // obwohl der Pfad kaputt war.
  const created = [];
  const byUpsertKey = new Map();
  function upsertKeyOf(dto) {
    const owner = dto.projectId ? `p:${dto.projectId}` : `c:${dto.customerId}`;
    const env = dto.environmentId ?? 'null';
    return `${owner}|${env}|${dto.key}`;
  }
  return {
    _created: created,
    async create(dto) {
      const k = upsertKeyOf(dto);
      const existing = byUpsertKey.get(k);
      if (existing) {
        // Upsert-Treffer: derselbe Datensatz wird überschrieben, NICHT neu
        // angelegt — `created` wächst hier bewusst nicht.
        existing.dto = dto;
        return { _id: String(existing._id) };
      }
      const _id = new Types.ObjectId();
      const entry = { _id, dto };
      byUpsertKey.set(k, entry);
      created.push(entry);
      return { _id: String(_id) };
    },
    async findById(id) {
      const hit = created.find((c) => String(c._id) === String(id));
      if (!hit) throw new Error('not found');
      return { value: hit.dto.value };
    },
  };
}

(async () => {
  const PROJECT = new Types.ObjectId();
  const GOOD_KUBECONFIG = [
    'apiVersion: v1', 'kind: Config', 'current-context: prod',
    'contexts:', '  - name: prod',
    '    context: { cluster: c, user: u }',
    'clusters:', '  - name: c',
    '    cluster: { server: "https://prod:6443", certificate-authority-data: Zm9v }',
    'users:', '  - name: u', '    user: { token: t }',
  ].join('\n');

  await check('create legt Cluster und Owned-Secret an', async () => {
    const clusterModel = makeModel();
    const secretModel = makeModel();
    const secrets = makeSecretsService();
    const svc = new KubeClustersService(clusterModel, secretModel, secrets, makeTransportStub());
    const doc = await svc.create({
      label: 'Prod', slug: 'prod', projectId: String(PROJECT),
      kubeconfig: GOOD_KUBECONFIG, contextName: 'prod', transport: 'direct',
    });
    assert.ok(doc.kubeconfigSecretId, 'kubeconfigSecretId fehlt');
    assert.equal(secrets._created.length, 1, 'kein Secret angelegt');
    assert.equal(secrets._created[0].dto.value, GOOD_KUBECONFIG);
  });

  await check('create rollt das Secret zurück, wenn der Slug im Scope bereits existiert (409, nicht 500)', async () => {
    const clusterModel = makeModel();
    const secretModel = makeModel();
    const secrets = makeSecretsService();
    const svc = new KubeClustersService(clusterModel, secretModel, secrets, makeTransportStub());

    // Simuliert Mongos Unique-Index-Verletzung (E11000), wie sie beim
    // zweiten Cluster mit demselben Slug im selben Scope auftreten würde.
    const dupErr = new Error(
      'E11000 duplicate key error collection: devgrimoire.kubeclusters index: ' +
      'projectId_1_slug_1 dup key: { projectId: ObjectId(...), slug: "prod" }',
    );
    dupErr.code = 11000;
    clusterModel.create = async () => { throw dupErr; };

    let deletedFilter = null;
    secretModel.deleteMany = (f) => { deletedFilter = f; return { exec: async () => ({ deletedCount: 1 }) }; };

    const err = await svc.create({
      label: 'Prod', slug: 'prod', projectId: String(PROJECT),
      kubeconfig: GOOD_KUBECONFIG, contextName: 'prod', transport: 'direct',
    }).then(() => null, (e) => e);

    assert.ok(err, 'hätte fehlschlagen müssen');
    assert.equal(err.status, 409, 'Duplicate-Slug muss Conflict sein, nicht 500');
    assert.equal(secrets._created.length, 1, 'Secret muss vor dem Duplicate-Error angelegt worden sein');
    assert.ok(deletedFilter, 'Rollback (secretModel.deleteMany) wurde nicht gerufen');
    assert.equal(
      String(deletedFilter._id.$in[0]),
      String(secrets._created[0]._id),
      'Rollback muss genau das eben angelegte Secret löschen',
    );
  });

  await check('create übernimmt clusterServer aus der Kubeconfig', async () => {
    const svc = new KubeClustersService(makeModel(), makeModel(), makeSecretsService(), makeTransportStub());
    const doc = await svc.create({
      label: 'Prod', slug: 'prod', projectId: String(PROJECT),
      kubeconfig: GOOD_KUBECONFIG, contextName: 'prod', transport: 'direct',
    });
    assert.equal(doc.clusterServer, 'https://prod:6443');
  });

  await check('create lehnt unbekannten Context ab', async () => {
    const svc = new KubeClustersService(makeModel(), makeModel(), makeSecretsService(), makeTransportStub());
    const err = await svc.create({
      label: 'X', slug: 'x', projectId: String(PROJECT),
      kubeconfig: GOOD_KUBECONFIG, contextName: 'gibtsnicht', transport: 'direct',
    }).then(() => null, (e) => e);
    assert.ok(err, 'hätte fehlschlagen müssen');
    assert.match(String(err.message), /context/i);
  });

  await check('create lehnt Exec-Plugin-Kubeconfig ab', async () => {
    const svc = new KubeClustersService(makeModel(), makeModel(), makeSecretsService(), makeTransportStub());
    const EXEC = GOOD_KUBECONFIG.replace('user: { token: t }', 'user: { exec: { apiVersion: v1, command: aws } }');
    const err = await svc.create({
      label: 'X', slug: 'x', projectId: String(PROJECT),
      kubeconfig: EXEC, contextName: 'prod', transport: 'direct',
    }).then(() => null, (e) => e);
    assert.ok(err, 'hätte fehlschlagen müssen');
    assert.match(String(err.message), /exec/i);
  });

  await check('delete räumt das Owned-Secret mit ab', async () => {
    const clusterModel = makeModel();
    const secretModel = makeModel();
    const svc = new KubeClustersService(clusterModel, secretModel, makeSecretsService(), makeTransportStub());
    const doc = await svc.create({
      label: 'Prod', slug: 'prod', projectId: String(PROJECT),
      kubeconfig: GOOD_KUBECONFIG, contextName: 'prod', transport: 'direct',
    });
    let deletedFilter = null;
    secretModel.deleteMany = (f) => { deletedFilter = f; return { exec: async () => ({ deletedCount: 1 }) }; };
    await svc.delete(String(doc._id));
    assert.ok(deletedFilter, 'deleteMany wurde nicht gerufen');
    assert.equal(String(deletedFilter.ownedByKubeClusterId), String(doc._id));
    assert.equal(clusterModel._store.has(String(doc._id)), false, 'Cluster nicht gelöscht');
  });

  await check('findByProjectId filtert nach Scope', async () => {
    const clusterModel = makeModel();
    const svc = new KubeClustersService(clusterModel, makeModel(), makeSecretsService(), makeTransportStub());
    await svc.create({ label: 'A', slug: 'a', projectId: String(PROJECT), kubeconfig: GOOD_KUBECONFIG, contextName: 'prod', transport: 'direct' });
    await svc.create({ label: 'B', slug: 'b', projectId: String(new Types.ObjectId()), kubeconfig: GOOD_KUBECONFIG, contextName: 'prod', transport: 'direct' });
    const found = await svc.findByProjectId(String(PROJECT));
    assert.equal(found.length, 1);
    assert.equal(found[0].slug, 'a');
  });

  await check('allowMcpWrites bei readOnly wird als BadRequest abgelehnt', async () => {
    const svc = new KubeClustersService(makeModel(), makeModel(), makeSecretsService(), makeTransportStub());
    const err = await svc.create({
      label: 'X', slug: 'x', projectId: String(PROJECT), kubeconfig: GOOD_KUBECONFIG,
      contextName: 'prod', transport: 'direct', allowMcpWrites: true,
    }).then(() => null, (e) => e);
    assert.ok(err, 'hätte fehlschlagen müssen');
    assert.equal(err.status, 400, 'muss BadRequest sein, nicht ValidationError/500');
  });

  await check('ssh-tunnel ohne sshConnectionId wird als BadRequest abgelehnt', async () => {
    const svc = new KubeClustersService(makeModel(), makeModel(), makeSecretsService(), makeTransportStub());
    const err = await svc.create({
      label: 'X', slug: 'x', projectId: String(PROJECT), kubeconfig: GOOD_KUBECONFIG,
      contextName: 'prod', transport: 'ssh-tunnel',
    }).then(() => null, (e) => e);
    assert.ok(err, 'hätte fehlschlagen müssen');
    assert.equal(err.status, 400);
  });

  await check('create ohne projectId und customerId wird als BadRequest abgelehnt', async () => {
    const secrets = makeSecretsService();
    const svc = new KubeClustersService(makeModel(), makeModel(), secrets, makeTransportStub());
    const err = await svc.create({
      label: 'X', slug: 'x', kubeconfig: GOOD_KUBECONFIG,
      contextName: 'prod', transport: 'direct',
    }).then(() => null, (e) => e);
    assert.ok(err, 'hätte fehlschlagen müssen');
    assert.equal(err.status, 400, 'muss BadRequest sein, nicht ValidationError/500');
    assert.equal(secrets._created.length, 0, 'darf kein Secret anlegen, bevor der Scope geprüft ist');
  });

  await check('create mit projectId UND customerId wird als BadRequest abgelehnt', async () => {
    const secrets = makeSecretsService();
    const svc = new KubeClustersService(makeModel(), makeModel(), secrets, makeTransportStub());
    const err = await svc.create({
      label: 'X', slug: 'x', projectId: String(PROJECT), customerId: String(new Types.ObjectId()),
      kubeconfig: GOOD_KUBECONFIG, contextName: 'prod', transport: 'direct',
    }).then(() => null, (e) => e);
    assert.ok(err, 'hätte fehlschlagen müssen');
    assert.equal(err.status, 400, 'muss BadRequest sein, nicht ValidationError/500');
    assert.equal(secrets._created.length, 0, 'darf kein Secret anlegen, bevor der Scope geprüft ist');
  });

  await check('prometheus.enabled ohne namespace/service/port wird als BadRequest abgelehnt', async () => {
    const secrets = makeSecretsService();
    const svc = new KubeClustersService(makeModel(), makeModel(), secrets, makeTransportStub());
    const err = await svc.create({
      label: 'X', slug: 'x', projectId: String(PROJECT), kubeconfig: GOOD_KUBECONFIG,
      contextName: 'prod', transport: 'direct',
      prometheus: { enabled: true },
    }).then(() => null, (e) => e);
    assert.ok(err, 'hätte fehlschlagen müssen');
    assert.equal(err.status, 400, 'muss BadRequest sein, nicht ValidationError/500');
    assert.equal(secrets._created.length, 0, 'darf kein Secret anlegen, bevor die Invariante geprüft ist');
  });

  await check('create überschreibt nicht das Secret des ersten Clusters, wenn ein zweiter mit demselben Slug im selben Scope fehlschlägt', async () => {
    // Regression für den kritischen Bug aus Fix-Runde 1: SecretsService.create()
    // ist kein Insert, sondern ein Upsert über (Scope, environmentId, Key)
    // (backend/src/secrets/secrets.service.ts:66-76). Ein slug-basierter Key
    // hätte beim zweiten, zum Scheitern verurteilten create()-Aufruf denselben
    // Key wie der erste getroffen — der Upsert hätte das Secret des ERSTEN,
    // erfolgreichen Clusters mit dem Inhalt des zweiten überschrieben, und der
    // anschließende Rollback hätte es dann gelöscht. Zwei ECHTE create()-Aufrufe
    // hier, kein gemockter clusterModel.create — nur so kann die reale
    // Slug-Kollision (siehe makeModel()) überhaupt auftreten.
    const clusterModel = makeModel();
    const secretModel = makeModel();
    const secrets = makeSecretsService();
    const svc = new KubeClustersService(clusterModel, secretModel, secrets, makeTransportStub());

    const SECOND_KUBECONFIG = GOOD_KUBECONFIG.replace('token: t', 'token: t-second');

    const first = await svc.create({
      label: 'Erster', slug: 'prod', projectId: String(PROJECT),
      kubeconfig: GOOD_KUBECONFIG, contextName: 'prod', transport: 'direct',
    });

    const err = await svc.create({
      label: 'Zweiter', slug: 'prod', projectId: String(PROJECT),
      kubeconfig: SECOND_KUBECONFIG, contextName: 'prod', transport: 'direct',
    }).then(() => null, (e) => e);

    assert.ok(err, 'zweiter create() mit demselben Slug im selben Scope hätte scheitern müssen');
    assert.equal(err.status, 409, 'Duplicate-Slug muss 409 sein');

    const firstSecretAfterwards = await secrets.findById(String(first.kubeconfigSecretId));
    assert.equal(
      firstSecretAfterwards.value,
      GOOD_KUBECONFIG,
      'das Secret des ERSTEN, erfolgreichen Clusters wurde vom fehlgeschlagenen zweiten Aufruf überschrieben',
    );
    assert.equal(
      secrets._created.length,
      2,
      'zwei create()-Aufrufe müssen zwei eigenständige Secrets anlegen (verschiedene Keys), nicht per Upsert denselben Datensatz treffen',
    );

    const stillThere = await svc.findById(String(first._id));
    assert.equal(
      String(stillThere.kubeconfigSecretId),
      String(first.kubeconfigSecretId),
      'der erste Cluster muss weiterhin auf sein eigenes, unverändertes Secret zeigen',
    );
  });

  // ------------------------------------------------------------------
  // create(): Server-URL-Invarianten (I5 / I8)
  // ------------------------------------------------------------------

  await check('create lehnt einen nicht-https Cluster-Server als 400 ab', async () => {
    // Der Parser winkt `http://prod:8080` mit einer blossen `no_ca`-Warnung
    // durch — der Cluster war anlegbar und funktionierte danach, mit
    // `Authorization: Bearer <token>` im Klartext auf der Leitung.
    const secrets = makeSecretsService();
    const svc = new KubeClustersService(makeModel(), makeModel(), secrets, makeTransportStub());
    const PLAIN = GOOD_KUBECONFIG.replace('https://prod:6443', 'http://prod:8080');
    const err = await svc.create({
      label: 'X', slug: 'x', projectId: String(PROJECT), kubeconfig: PLAIN,
      contextName: 'prod', transport: 'direct', allowInsecureTls: true,
    }).then(() => null, (e) => e);
    assert.ok(err, 'http-Cluster-Server wurde akzeptiert');
    assert.equal(err.status, 400);
    assert.match(String(err.message), /https/i);
    assert.equal(secrets._created.length, 0, 'darf kein Secret anlegen, bevor die Server-URL geprüft ist');
  });

  await check('create lehnt einen Context ohne Cluster-Eintrag als 400 ab (nicht 500)', async () => {
    // Ein Context, der auf einen in der Datei fehlenden Cluster zeigt,
    // parst anstandslos und liefert `server: ''`. create() kopierte das in
    // das `required: true`-Feld clusterServer → Mongoose-ValidationError →
    // HTTP 500 aus Caller-Input.
    const secrets = makeSecretsService();
    const svc = new KubeClustersService(makeModel(), makeModel(), secrets, makeTransportStub());
    const DANGLING = [
      'apiVersion: v1', 'kind: Config', 'current-context: prod',
      'contexts:', '  - name: prod',
      '    context: { cluster: gibtsnicht, user: u }',
      'clusters: []',
      'users:', '  - name: u', '    user: { token: t }',
    ].join('\n');
    const err = await svc.create({
      label: 'X', slug: 'x', projectId: String(PROJECT), kubeconfig: DANGLING,
      contextName: 'prod', transport: 'direct', allowInsecureTls: true,
    }).then(() => null, (e) => e);
    assert.ok(err, 'Context ohne Cluster-Eintrag wurde akzeptiert');
    assert.equal(err.status, 400, 'muss BadRequest sein, nicht ValidationError/500');
    assert.equal(secrets._created.length, 0, 'darf kein Secret anlegen, bevor die Server-URL geprüft ist');
  });

  // ------------------------------------------------------------------
  // update() / recordConnect* — bis hierhin ohne jede Abdeckung (A2)
  // ------------------------------------------------------------------

  const SSH_A = new Types.ObjectId();
  const SSH_B = new Types.ObjectId();

  async function makeTunnelCluster(overrides = {}) {
    const clusterModel = makeModel();
    const transport = makeTransportStub();
    const svc = new KubeClustersService(clusterModel, makeModel(), makeSecretsService(), transport);
    const doc = await svc.create({
      label: 'Prod', slug: 'prod', projectId: String(PROJECT),
      kubeconfig: GOOD_KUBECONFIG, contextName: 'prod',
      transport: 'ssh-tunnel', sshConnectionId: String(SSH_A),
      ...overrides,
    });
    return { svc, doc, transport, clusterModel };
  }

  await check('update ändert Metadaten und schreibt sie zurück', async () => {
    const { svc, doc, clusterModel } = await makeTunnelCluster();
    const out = await svc.update(String(doc._id), {
      label: 'Produktion', defaultNamespace: 'apps', description: 'neu', tags: ['a', 'b'],
    });
    assert.equal(out.label, 'Produktion');
    assert.equal(out.defaultNamespace, 'apps');
    assert.equal(out.description, 'neu');
    assert.deepEqual(out.tags, ['a', 'b']);
    assert.equal(clusterModel._store.get(String(doc._id)).label, 'Produktion', 'doc.save() wurde nicht gerufen');
  });

  await check('update lehnt allowMcpWrites bei readOnly als 400 ab', async () => {
    const { svc, doc } = await makeTunnelCluster();
    const err = await svc.update(String(doc._id), { allowMcpWrites: true }).then(() => null, (e) => e);
    assert.ok(err, 'hätte fehlschlagen müssen');
    assert.equal(err.status, 400, 'muss BadRequest sein, nicht ValidationError/500');
  });

  await check('update lehnt ssh-tunnel ohne sshConnectionId als 400 ab', async () => {
    const clusterModel = makeModel();
    const svc = new KubeClustersService(clusterModel, makeModel(), makeSecretsService(), makeTransportStub());
    const doc = await svc.create({
      label: 'Prod', slug: 'prod', projectId: String(PROJECT),
      kubeconfig: GOOD_KUBECONFIG, contextName: 'prod', transport: 'direct',
    });
    const err = await svc.update(String(doc._id), { transport: 'ssh-tunnel' }).then(() => null, (e) => e);
    assert.ok(err, 'hätte fehlschlagen müssen');
    assert.equal(err.status, 400);
  });

  await check('update lehnt prometheus.enabled ohne namespace/service/port als 400 ab', async () => {
    const { svc, doc } = await makeTunnelCluster();
    const err = await svc.update(String(doc._id), { prometheus: { enabled: true } }).then(() => null, (e) => e);
    assert.ok(err, 'hätte fehlschlagen müssen');
    assert.equal(err.status, 400);
  });

  await check('update füllt prometheus.path auf den Schema-Default auf', async () => {
    const { svc, doc } = await makeTunnelCluster();
    const out = await svc.update(String(doc._id), {
      prometheus: { enabled: true, namespace: 'monitoring', service: 'prom', port: 9090 },
    });
    assert.equal(out.prometheus.path, '/');
  });

  await check('update verwirft den Tunnel-Cache, wenn transport wechselt', async () => {
    // I2: sonst tunnelt der Cluster bis zu eine Idle-TTL lang weiter über
    // den ALTEN Bastion-Host — mit K2s Polling potenziell unbegrenzt.
    const { svc, doc, transport } = await makeTunnelCluster();
    await svc.update(String(doc._id), { transport: 'direct' });
    assert.deepEqual(transport._invalidated, [String(doc._id)], 'Tunnel-Cache wurde nicht verworfen');
  });

  await check('update verwirft den Tunnel-Cache, wenn sshConnectionId wechselt', async () => {
    const { svc, doc, transport } = await makeTunnelCluster();
    await svc.update(String(doc._id), { sshConnectionId: String(SSH_B) });
    assert.deepEqual(transport._invalidated, [String(doc._id)], 'Bastion gewechselt, Tunnel-Cache blieb stehen');
  });

  await check('update lässt den Tunnel-Cache bei einer reinen Label-Änderung in Ruhe', async () => {
    // Invalidieren schliesst den Tunnel sofort, auch unter laufenden
    // Requests. Für eine Umbenennung wäre das grundlose Störung.
    const { svc, doc, transport } = await makeTunnelCluster();
    await svc.update(String(doc._id), { label: 'Nur umbenannt' });
    assert.deepEqual(transport._invalidated, [], 'reine Umbenennung hat den Tunnel abgerissen');
  });

  await check('delete verwirft den Tunnel-Cache', async () => {
    // I2: sonst überleben Listener und ssh2-Client die gelöschte Entität.
    const { svc, doc, transport } = await makeTunnelCluster();
    await svc.delete(String(doc._id));
    assert.deepEqual(transport._invalidated, [String(doc._id)], 'Tunnel überlebt den gelöschten Cluster');
  });

  await check('recordConnectSuccess setzt lastConnectedAt und löscht lastConnectError', async () => {
    const { svc, doc } = await makeTunnelCluster();
    await svc.recordConnectError(String(doc._id), 'kaputt');
    const after = await svc.recordConnectSuccess(String(doc._id));
    assert.ok(after.lastConnectedAt instanceof Date, 'lastConnectedAt nicht gesetzt');
    assert.equal(after.lastConnectError, undefined, 'alter Fehler blieb stehen');
  });

  await check('recordConnectError kürzt die Meldung auf 500 Zeichen', async () => {
    const { svc, doc } = await makeTunnelCluster();
    const after = await svc.recordConnectError(String(doc._id), 'x'.repeat(5000));
    assert.equal(after.lastConnectError.message.length, 500);
    assert.ok(after.lastConnectError.at instanceof Date);
  });

  await check('findById wirft NotFound bei unbekannter Id', async () => {
    const svc = new KubeClustersService(makeModel(), makeModel(), makeSecretsService(), makeTransportStub());
    const err = await svc.findById(String(new Types.ObjectId())).then(() => null, (e) => e);
    assert.ok(err, 'hätte werfen müssen');
  });

  await check('findById wirft bei ungültiger Id statt zu filtern', async () => {
    const svc = new KubeClustersService(makeModel(), makeModel(), makeSecretsService(), makeTransportStub());
    const err = await svc.findById('keine-objectid').then(() => null, (e) => e);
    assert.ok(err, 'ungültige Id muss abgelehnt werden, nicht in den Filter wandern');
  });

  console.log('');
  console.log(`Kube service unit checks: ${total - failures}/${total} passed`);
  if (failures > 0) process.exit(1);
})();
