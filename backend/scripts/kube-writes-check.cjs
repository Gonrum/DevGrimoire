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

const { KubeWritesService } = loadCompiled('kube/kube-writes.service.js');

const EXPECTED_CHECKS = 27;  // 22 Einzelfälle + 5 Läufe der readOnly-Schleife
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
  const clusters = {
    async findById() {
      return { _id: 'c1', projectId: 'p1', readOnly: opts.readOnly === true, contextName: 'x' };
    },
  };
  const client = {
    async buildConfig() {
      if (opts.buildFails) throw new Error('tunnel weg');
      state.built += 1;
      return {
        kc: {
          makeApiClient: (cls) => new Proxy({}, {
            get: (_t, method) => async (param) => {
              state.calls.push({ method: String(method), param, api: cls && cls.name });
              if (opts.apiThrows) throw new Error('cluster weg');
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

  await check('apply ersetzt ein vorhandenes Objekt mit dessen resourceVersion', async () => {
    const env = makeEnv({ responses: { readNamespacedConfigMap: { metadata: { name: 'a', resourceVersion: '77' } } } });
    const yaml = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\ndata: {k: v}';
    await env.svc.apply({ ...base, yaml, namespace: 'n' });
    const rep = env.state.calls.find((c) => c.method === 'replaceNamespacedConfigMap');
    assert.ok(rep, 'kein Replace');
    assert.equal(rep.param.body.metadata.resourceVersion, '77');
    assert.ok(!env.state.calls.some((c) => c.method === 'createNamespacedConfigMap'));
  });

  await check('apply legt an, wenn das Objekt nicht existiert (404)', async () => {
    const env = makeEnv({ notFoundOnRead: true });
    const yaml = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\ndata: {k: v}';
    await env.svc.apply({ ...base, yaml, namespace: 'n' });
    const cr = env.state.calls.find((c) => c.method === 'createNamespacedConfigMap');
    assert.ok(cr, 'kein Create');
    assert.equal(cr.param.namespace, 'n');
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

  console.log('');
  if (total !== EXPECTED_CHECKS) {
    console.error(`✗ erwartet ${EXPECTED_CHECKS} Prüfungen, ${total} gelaufen`);
    failures += 1;
  }
  console.log(`Kube writes checks: ${total - failures}/${total} passed`);
  process.exit(failures > 0 ? 1 : 0);
})();
