#!/usr/bin/env node
/*
 * Check für KubeWritesService (K3, Task 5).
 *
 * Schwerpunkte: die readOnly- und Scope-Grenze greift VOR jedem
 * Verbindungsaufbau, der Katalog erlaubter Kinds hält, und jede Aktion
 * hinterlässt eine Audit-Zeile — auch die fehlgeschlagene. In K2 wurde
 * festgestellt, dass fehlgeschlagene Reads keine Spur hinterlassen; bei
 * Schreibaktionen ist der Versuch die interessante Information.
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

const { KubeWritesService, APPLYABLE_KINDS } = loadCompiled('kube/kube-writes.service.js');
const { assertClusterAccess } = loadCompiled('kube/kube-access.guard.js');
const { RequestContext } = loadCompiled('common/request-context.js');
const { KubeAuditService, KUBE_AUDIT_FIELD_MAX } = loadCompiled('kube/kube-audit.service.js');
const { KubeAuditSchema } = loadCompiled('kube/schemas/kube-audit.schema.js');
const { NotFoundException } = require('@nestjs/common');
const { ApiException } = require('@kubernetes/client-node');
const mongoose = require('mongoose');

// 22 Einzelfälle (zwei davon im finalen Review durch SSA-Fälle ersetzt) + 5 Läufe der
// readOnly-Schleife + 11 Fälle aus dem finalen Review (I1, I3, I4, I5, M3, M4, M5, T7)
const EXPECTED_CHECKS = 38;
const CHECK_TIMEOUT_MS = 3000;
let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  const guard = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`Zeitlimit (${CHECK_TIMEOUT_MS}ms)`)), CHECK_TIMEOUT_MS).unref());
  return Promise.race([Promise.resolve().then(fn), guard]).then(
    () => console.log(`✓ ${label}`),
    (err) => { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); },
  );
}

const ADMIN = { projectScopeMode: 'all' };

function makeEnv(opts = {}) {
  const state = { built: 0, released: 0, audits: [], calls: [] };
  const cluster = { _id: 'c1', projectId: 'p1', label: 'Prod', readOnly: opts.readOnly === true, contextName: 'x' };
  // Die Attrappe verhält sich wie KubeClustersService: findById() prüft den
  // Scope gegen den Actor im RequestContext (403 VOR dem auditierten Pfad),
  // findByIdUnscoped() nicht. Bis zum finalen Review prüfte die Attrappe gar
  // nicht — der Scope-Audit-Fall bestand, obwohl produktiv keine Zeile entstand.
  const clusters = {
    async findById(id) {
      if (id === 'missing') throw new NotFoundException(`Kube-Cluster ${id} nicht gefunden`);
      const actor = RequestContext.getUser();
      if (actor) assertClusterAccess(cluster, actor);
      return cluster;
    },
    async findByIdUnscoped(id) {
      if (id === 'missing') throw new NotFoundException(`Kube-Cluster ${id} nicht gefunden`);
      return cluster;
    },
  };
  const client = {
    async buildConfig() {
      if (opts.buildFails) throw new Error('tunnel weg');
      state.built += 1;
      return {
        kc: {
          makeApiClient: (cls) => new Proxy({}, {
            get: (_t, method) => async (param, options) => {
              state.calls.push({ method: String(method), param, options, api: cls && cls.name });
              if (opts.apiThrows) throw new Error('cluster weg');
              if (opts.throwFor && opts.throwFor(String(method), param)) throw opts.throwFor(String(method), param);
              if (opts.notFoundOnRead && /^read/.test(String(method))) {
                throw Object.assign(new Error('nicht gefunden'), { code: 404 });
              }
              return opts.responses?.[String(method)] ?? {};
            },
          }),
        },
        release: () => { state.released += 1; },
      };
    },
  };
  const audit = { async record(e) { state.audits.push(e); } };
  return { state, svc: new KubeWritesService(clusters, client, audit) };
}

const base = { clusterId: 'c1', actor: ADMIN, userId: 'u1' };

(async () => {
  // ---- Grenze: readOnly -------------------------------------------------
  for (const [label, call] of [
    ['scale',   (s) => s.scale({ ...base, kind: 'Deployment', name: 'a', namespace: 'n', replicas: 2 })],
    ['restart', (s) => s.restart({ ...base, kind: 'Deployment', name: 'a', namespace: 'n' })],
    ['delete',  (s) => s.remove({ ...base, kind: 'Pod', name: 'a', namespace: 'n' })],
    ['cordon',  (s) => s.cordon({ ...base, node: 'n1', unschedulable: true })],
    ['apply',   (s) => s.apply({ ...base, yaml: 'kind: Pod\napiVersion: v1\nmetadata: {name: a}', namespace: 'n' })],
  ]) {
    await check(`readOnly-Cluster lehnt ${label} ab, bevor verbunden wird`, async () => {
      const env = makeEnv({ readOnly: true });
      const err = await call(env.svc).then(() => null, (e) => e);
      assert.ok(err, 'hätte werfen müssen');
      assert.equal(err.status, 403);
      assert.equal(env.state.built, 0, 'es wurde trotzdem eine Verbindung aufgebaut');
    });
  }

  // ---- Grenze: Scope ----------------------------------------------------
  await check('fehlender Scope lehnt ab, bevor verbunden wird', async () => {
    const env = makeEnv();
    const err = await env.svc.scale({
      ...base, actor: { projectScopeMode: 'restricted', allowedProjectIds: ['fremd'] },
      kind: 'Deployment', name: 'a', namespace: 'n', replicas: 1,
    }).then(() => null, (e) => e);
    assert.ok(err, 'hätte werfen müssen');
    assert.equal(err.status, 403);
    assert.equal(env.state.built, 0);
  });

  // ---- Katalog ----------------------------------------------------------
  await check('scale auf ein nicht skalierbares Kind wird abgelehnt', async () => {
    const env = makeEnv();
    const err = await env.svc.scale({ ...base, kind: 'Pod', name: 'a', namespace: 'n', replicas: 2 })
      .then(() => null, (e) => e);
    assert.ok(err); assert.equal(err.status, 400); assert.equal(env.state.built, 0);
  });

  await check('delete akzeptiert nur Pod und Job', async () => {
    const env = makeEnv();
    const err = await env.svc.remove({ ...base, kind: 'Deployment', name: 'a', namespace: 'n' })
      .then(() => null, (e) => e);
    assert.ok(err, 'delete auf ein Deployment ist eine andere Grössenordnung und lässt sich aus DevGrimoire nicht auslösen');
    assert.equal(err.status, 400);
    assert.equal(env.state.built, 0);
  });

  await check('negative Replica-Zahl wird abgelehnt', async () => {
    const env = makeEnv();
    const err = await env.svc.scale({ ...base, kind: 'Deployment', name: 'a', namespace: 'n', replicas: -1 })
      .then(() => null, (e) => e);
    assert.ok(err); assert.equal(err.status, 400); assert.equal(env.state.built, 0);
  });

  // ---- Verhalten --------------------------------------------------------
  await check('scale übergibt die Replica-Zahl an die API', async () => {
    const env = makeEnv();
    await env.svc.scale({ ...base, kind: 'Deployment', name: 'api', namespace: 'prod', replicas: 3 });
    const call = env.state.calls.find((c) => /^replaceNamespaced\w+Scale$/.test(c.method));
    assert.ok(call, `kein Scale-Aufruf; gesehen: ${env.state.calls.map((c) => c.method).join(', ')}`);
    assert.equal(call.param.body.spec.replicas, 3, 'die Replica-Zahl fehlt im Aufruf');
  });

  await check('restart setzt die kubectl-kompatible Annotation', async () => {
    const env = makeEnv();
    await env.svc.restart({ ...base, kind: 'Deployment', name: 'api', namespace: 'prod' });
    const json = JSON.stringify(env.state.calls);
    assert.ok(json.includes('kubectl.kubernetes.io/restartedAt'),
      'ohne diese Annotation sieht ein späteres `kubectl rollout status` etwas anderes als unsere UI');
  });

  await check('cordon setzt spec.unschedulable, uncordon entfernt es', async () => {
    const on = makeEnv();
    await on.svc.cordon({ ...base, node: 'n1', unschedulable: true });
    assert.ok(JSON.stringify(on.state.calls).includes('"value":true'));
    const off = makeEnv();
    await off.svc.cordon({ ...base, node: 'n1', unschedulable: false });
    assert.ok(JSON.stringify(off.state.calls).includes('"value":false'));
  });

  await check('apply lehnt ein Dokument ohne kind oder metadata.name ab', async () => {
    const env = makeEnv();
    const err = await env.svc.apply({ ...base, yaml: 'apiVersion: v1\nmetadata: {}', namespace: 'n' })
      .then(() => null, (e) => e);
    assert.ok(err); assert.equal(err.status, 400); assert.equal(env.state.built, 0);
  });

  await check('apply lehnt ein Dokument mit fremdem Namespace ab', async () => {
    const env = makeEnv();
    const yaml = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n  namespace: woanders';
    const err = await env.svc.apply({ ...base, yaml, namespace: 'prod' }).then(() => null, (e) => e);
    assert.ok(err, 'ein Dokument darf nicht in einen anderen Namespace schreiben als den angefragten');
    assert.equal(err.status, 400);
    assert.equal(env.state.built, 0);
  });

  // ---- Audit ------------------------------------------------------------
  await check('jede Aktion schreibt eine Audit-Zeile mit Verb, Ressource und Namen', async () => {
    const env = makeEnv();
    await env.svc.scale({ ...base, kind: 'Deployment', name: 'api', namespace: 'prod', replicas: 2 });
    assert.equal(env.state.audits.length, 1);
    const a = env.state.audits[0];
    assert.equal(a.action, 'write');
    assert.equal(a.verb, 'scale');
    assert.equal(a.resource, 'Deployment');
    assert.equal(a.name, 'api');
    assert.equal(a.namespace, 'prod');
  });

  await check('auch eine FEHLGESCHLAGENE Aktion schreibt eine Audit-Zeile', async () => {
    const env = makeEnv({ apiThrows: true });
    await env.svc.scale({ ...base, kind: 'Deployment', name: 'api', namespace: 'prod', replicas: 2 })
      .then(() => null, () => {});
    assert.equal(env.state.audits.length, 1, 'der Versuch ist die Zeile, die man später sucht');
    assert.ok(env.state.audits[0].errorMsg, 'errorMsg fehlt');
  });

  await check('der Transport wird auf jedem Pfad genau einmal freigegeben', async () => {
    const ok = makeEnv();
    await ok.svc.restart({ ...base, kind: 'Deployment', name: 'a', namespace: 'n' });
    assert.equal(ok.state.released, 1, `Erfolg: released=${ok.state.released}`);
    const bad = makeEnv({ apiThrows: true });
    await bad.svc.restart({ ...base, kind: 'Deployment', name: 'a', namespace: 'n' })
      .then(() => null, () => {});
    assert.equal(bad.state.released, 1, `Fehlerfall: released=${bad.state.released}`);
  });

  await check('cordon schickt ein JSON-Patch-ARRAY, kein Merge-Objekt', async () => {
    const env = makeEnv();
    await env.svc.cordon({ ...base, node: 'n1', unschedulable: true });
    const call = env.state.calls.find((c) => /patchNode/i.test(c.method));
    assert.ok(Array.isArray(call.param.body),
      'der Client sendet application/json-patch+json — ein Objekt-Body ergibt 422');
    assert.equal(call.param.body[0].op, 'add');
    assert.equal(call.param.body[0].path, '/spec/unschedulable');
  });

  await check('restart erhält bestehende Annotationen', async () => {
    const env = makeEnv({ responses: { readNamespacedDeployment: {
      metadata: { name: 'api' },
      spec: { template: { metadata: { annotations: { 'argocd.argoproj.io/sync-wave': '1' } } } },
    } } });
    await env.svc.restart({ ...base, kind: 'Deployment', name: 'api', namespace: 'prod' });
    const json = JSON.stringify(env.state.calls);
    assert.ok(json.includes('argocd.argoproj.io/sync-wave'),
      'fremde Annotationen wurden beim Replace verworfen');
    assert.ok(json.includes('kubectl.kubernetes.io/restartedAt'));
  });

  await check('apply lehnt ein Kind ausserhalb der Registry ab, bevor verbunden wird', async () => {
    const env = makeEnv();
    const yaml = 'apiVersion: v1\nkind: PersistentVolume\nmetadata:\n  name: a';
    const err = await env.svc.apply({ ...base, yaml, namespace: 'n' }).then(() => null, (e) => e);
    assert.ok(err); assert.equal(err.status, 400); assert.equal(env.state.built, 0);
  });

  await check('apply lehnt ein apiVersion/kind-Paar ab, das nicht zur Registry passt', async () => {
    const env = makeEnv();
    const yaml = 'apiVersion: apps/v1\nkind: ConfigMap\nmetadata:\n  name: a';
    const err = await env.svc.apply({ ...base, yaml, namespace: 'n' }).then(() => null, (e) => e);
    assert.ok(err); assert.equal(err.status, 400); assert.equal(env.state.built, 0);
  });

  // Ersetzt (finaler Review, I4): „apply ersetzt ein vorhandenes Objekt mit
  // dessen resourceVersion" und „apply legt an, wenn das Objekt nicht
  // existiert (404)" — beide pinnten die read/create/replace-Semantik, die
  // Server-Side Apply abgelöst hat.
  await check('apply schickt Server-Side Apply: PATCH mit apply-patch+yaml, fieldManager devgrimoire, force=false', async () => {
    const env = makeEnv();
    const yaml = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\ndata: {k: v}';
    const res = await env.svc.apply({ ...base, yaml, namespace: 'n' });
    assert.equal(env.state.calls.length, 1, `genau ein Aufruf erwartet; gesehen: ${env.state.calls.map((c) => c.method).join(', ')}`);
    const call = env.state.calls[0];
    assert.equal(call.method, 'patchNamespacedConfigMap');
    assert.equal(call.param.fieldManager, 'devgrimoire');
    assert.equal(call.param.force, false, 'force muss ausdrücklich false sein — ein Konflikt ist ein Fehler');
    assert.equal(call.param.body.metadata.namespace, 'n');
    assert.equal(call.param.body.kind, 'ConfigMap');
    // Die per-Call-Middleware muss den Content-Type auf Server-Side Apply setzen.
    assert.ok(call.options && Array.isArray(call.options.middleware), 'keine per-Call-Optionen');
    assert.equal(call.options.middlewareMergeStrategy, 'append', 'die Auth-Middleware des Clients muss erhalten bleiben');
    const headers = {};
    const ctx = { setHeaderParam: (k, v) => { headers[k] = v; } };
    for (const m of call.options.middleware) m.pre(ctx);
    assert.equal(headers['Content-Type'], 'application/apply-patch+yaml');
    assert.equal(res[0].detail, 'applied');
  });

  await check('apply liest, erstellt und ersetzt nicht mehr (kein replace-Pfad)', async () => {
    const env = makeEnv({ notFoundOnRead: true });
    const yaml = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec: {}';
    await env.svc.apply({ ...base, yaml, namespace: 'n' });
    assert.ok(!env.state.calls.some((c) => /^(read|create|replace)/.test(c.method)),
      `unerwartete Aufrufe: ${env.state.calls.map((c) => c.method).join(', ')}`);
    assert.equal(env.state.calls[0].method, 'patchNamespacedDeployment');
  });

  await check('eine readOnly-Ablehnung schreibt eine Audit-Zeile mit errorMsg und baut keine Verbindung', async () => {
    const env = makeEnv({ readOnly: true });
    await env.svc.scale({ ...base, kind: 'Deployment', name: 'a', namespace: 'n', replicas: 1 }).then(() => null, () => {});
    assert.equal(env.state.built, 0);
    assert.equal(env.state.audits.length, 1);
    assert.equal(env.state.audits[0].verb, 'scale');
    assert.ok(env.state.audits[0].errorMsg, 'errorMsg fehlt');
  });

  await check('eine Scope-Ablehnung schreibt eine Audit-Zeile mit errorMsg und baut keine Verbindung', async () => {
    const env = makeEnv();
    await env.svc.cordon({
      ...base, actor: { projectScopeMode: 'restricted', allowedProjectIds: ['fremd'] },
      node: 'n1', unschedulable: true,
    }).then(() => null, () => {});
    assert.equal(env.state.built, 0);
    assert.equal(env.state.audits.length, 1);
    assert.ok(env.state.audits[0].errorMsg, 'errorMsg fehlt');
  });

  await check('ein fehlgeschlagenes buildConfig schreibt eine Audit-Zeile und ruft release nicht', async () => {
    const env = makeEnv({ buildFails: true });
    const err = await env.svc.restart({ ...base, kind: 'Deployment', name: 'a', namespace: 'n' })
      .then(() => null, (e) => e);
    assert.ok(err);
    assert.equal(env.state.released, 0);
    assert.equal(env.state.audits.length, 1);
    assert.match(env.state.audits[0].errorMsg, /tunnel weg/);
  });

  await check('Job-Delete nutzt die Batch-Gruppe mit propagationPolicy Background', async () => {
    const env = makeEnv();
    await env.svc.remove({ ...base, kind: 'Job', name: 'j', namespace: 'n' });
    const call = env.state.calls.find((c) => c.method === 'deleteNamespacedJob');
    assert.ok(call);
    assert.equal(call.param.propagationPolicy, 'Background');
    assert.match(call.api, /BatchV1Api/);
  });

  // ---- Finaler Review --------------------------------------------------
  const OUTSIDE = { userId: 'u2', username: 'o', role: 'user', projectScopeMode: 'restricted', allowedProjectIds: ['fremd'] };

  await check('I1: Scope-Ablehnung bei Actor im RequestContext schreibt eine Audit-Zeile (produktiver Pfad)', async () => {
    for (const call of [
      (s) => s.scale({ ...base, actor: OUTSIDE, kind: 'Deployment', name: 'a', namespace: 'n', replicas: 1 }),
      (s) => s.apply({ ...base, actor: OUTSIDE, yaml: 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}', namespace: 'n' }),
    ]) {
      const env = makeEnv();
      const err = await RequestContext.run(OUTSIDE, undefined, () => call(env.svc)).then(() => null, (e) => e);
      assert.ok(err && err.status === 403, `403 erwartet, bekam ${err && err.status}`);
      assert.equal(env.state.built, 0);
      assert.equal(env.state.audits.length, 1, 'die Scope-Ablehnung blieb ohne Audit-Zeile');
      assert.match(env.state.audits[0].errorMsg, /Kein Zugriff/);
    }
  });

  await check('I1: unbekannte Cluster-Id -> 404 ohne Audit-Zeile', async () => {
    const env = makeEnv();
    const err = await env.svc.scale({ ...base, clusterId: 'missing', kind: 'Deployment', name: 'a', namespace: 'n', replicas: 1 })
      .then(() => null, (e) => e);
    assert.ok(err && err.status === 404);
    assert.equal(env.state.audits.length, 0);
  });

  await check('M3: ausserhalb des Scopes UND readOnly -> Scope-Meldung, readOnly bleibt verborgen', async () => {
    const env = makeEnv({ readOnly: true });
    const err = await RequestContext.run(OUTSIDE, undefined, () =>
      env.svc.restart({ ...base, actor: OUTSIDE, kind: 'Deployment', name: 'a', namespace: 'n' })).then(() => null, (e) => e);
    assert.ok(err && err.status === 403);
    assert.match(err.message, /Kein Zugriff/);
    assert.ok(!/read-only/i.test(err.message), `readOnly-Zustand geleakt: ${err.message}`);
  });

  await check('I3: Audit-errorMsg einer ApiException enthält weder Body noch Headers', async () => {
    const withStatus = makeEnv({ throwFor: (m) => /^replace/.test(m)
      && new ApiException(409, 'Conflict', { message: 'deployments "api" conflict' }, { 'audit-id': 'geheim-123' }) });
    await withStatus.svc.restart({ ...base, kind: 'Deployment', name: 'api', namespace: 'n' }).then(() => null, () => {});
    assert.equal(withStatus.state.audits[0].errorMsg, 'deployments "api" conflict');
    const raw = makeEnv({ throwFor: (m) => /^replace/.test(m)
      && new ApiException(500, 'Internal', 'proxy banner intern.example', { 'audit-id': 'geheim-123' }) });
    await raw.svc.restart({ ...base, kind: 'Deployment', name: 'api', namespace: 'n' }).then(() => null, () => {});
    const msg = raw.state.audits[0].errorMsg;
    assert.ok(msg && !/Body:|Headers:|geheim-123|intern\.example/.test(msg), `Debug-String im Audit: ${msg}`);
    assert.match(msg, /HTTP-Code: 500/);
  });

  await check('I5: APPLYABLE_KINDS ist die explizite Liste', async () => {
    assert.deepEqual([...APPLYABLE_KINDS].sort(),
      ['ConfigMap', 'CronJob', 'DaemonSet', 'Deployment', 'Ingress', 'Service', 'StatefulSet']);
  });

  for (const [kind, apiVersion] of [['Secret', 'v1'], ['Pod', 'v1']]) {
    await check(`I5: apply lehnt ${kind} ab (400, auditiert, keine Verbindung)`, async () => {
      const env = makeEnv();
      const yaml = `apiVersion: ${apiVersion}\nkind: ${kind}\nmetadata:\n  name: a\ndata: {k: djE=}`;
      const err = await env.svc.apply({ ...base, yaml, namespace: 'n' }).then(() => null, (e) => e);
      assert.ok(err && err.status === 400, `400 erwartet, bekam ${err && err.status}`);
      assert.equal(env.state.built, 0);
      assert.equal(env.state.audits.length, 1);
      assert.ok(env.state.audits[0].errorMsg);
    });
  }

  await check('M4: Mehrdokument-Fehler nennt Position und Zahl der bereits angewendeten, Status bleibt', async () => {
    const env = makeEnv({ throwFor: (m, p) => p && p.name === 'b'
      && new ApiException(409, 'Conflict', { message: 'Apply failed with 1 conflict' }, {}) });
    const yaml = ['a', 'b', 'c'].map((n) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${n}`).join('\n---\n');
    const err = await env.svc.apply({ ...base, yaml, namespace: 'n' }).then(() => null, (e) => e);
    assert.ok(err, 'hätte werfen müssen');
    assert.equal(err.getStatus(), 409, 'der Cluster-Status muss erhalten bleiben');
    assert.match(err.message, /Dokument 2 von 3 .*fehlgeschlagen, 1 bereits angewendet: Apply failed with 1 conflict/);
    assert.deepEqual(env.state.calls.map((c) => c.param.name), ['a', 'b'], 'Dokument 3 darf nicht mehr laufen');
    assert.equal(env.state.audits.length, 2);
    assert.ok(!env.state.audits[0].errorMsg && env.state.audits[1].errorMsg);
  });

  await check('M5: KubeAuditService speichert userId "system" als null statt die Zeile zu verlieren', async () => {
    const created = [];
    const svc = new KubeAuditService({ create: async (doc) => { created.push(doc); } });
    await svc.record({ clusterId: '0123456789abcdef01234567', action: 'write', sourceContext: 'rest', userId: 'system' });
    assert.equal(created.length, 1);
    assert.equal(created[0].userId, null);
    await svc.record({ clusterId: '0123456789abcdef01234567', action: 'write', sourceContext: 'rest', userId: 'abcdefabcdefabcdefabcdef' });
    assert.equal(String(created[1].userId), 'abcdefabcdefabcdefabcdef');
  });

  await check('M5: Schema nimmt userId null an, verlangt das Feld aber weiterhin', async () => {
    const Model = mongoose.models.KubeAuditCheck || mongoose.model('KubeAuditCheck', KubeAuditSchema);
    const base = { clusterId: new mongoose.Types.ObjectId(), action: 'write', sourceContext: 'rest' };
    assert.equal(new Model({ ...base, userId: null }).validateSync(), undefined, 'null muss gültig sein');
    const missing = new Model(base).validateSync();
    assert.ok(missing && missing.errors.userId, 'fehlendes userId muss weiterhin abgelehnt werden');
  });

  await check('T7: name/namespace/resource werden auf 253 Zeichen gekappt', async () => {
    const created = [];
    const svc = new KubeAuditService({ create: async (doc) => { created.push(doc); } });
    await svc.record({
      clusterId: '0123456789abcdef01234567', action: 'write', sourceContext: 'rest', userId: 'system',
      name: 'n'.repeat(1000), namespace: 's'.repeat(1000), resource: 'r'.repeat(1000),
    });
    assert.equal(KUBE_AUDIT_FIELD_MAX, 253);
    assert.equal(created[0].name.length, 253);
    assert.equal(created[0].namespace.length, 253);
    assert.equal(created[0].resource.length, 253);
  });

  console.log('');
  if (total !== EXPECTED_CHECKS) {
    console.error(`✗ erwartet ${EXPECTED_CHECKS} Prüfungen, ${total} gelaufen`);
    failures += 1;
  }
  console.log(`Kube writes checks: ${total - failures}/${total} passed`);
  process.exit(failures > 0 ? 1 : 0);
})();
