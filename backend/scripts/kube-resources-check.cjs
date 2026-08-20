#!/usr/bin/env node
/*
 * Check für KubeResourcesService (K2, Task 2).
 * Der Cluster wird gestubbt. Geprüft wird, was ohne Cluster prüfbar und
 * gleichzeitig gefährlich ist: dass release() auf JEDEM Pfad genau einmal
 * läuft, dass Secrets nie Werte tragen, und dass die Kind-Registry hält.
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

const { KubeResourcesService } = loadCompiled('kube/kube-resources.service.js');
const { isKubeKind, isNamespaced, KUBE_KINDS } = loadCompiled('kube/kube-kinds.js');

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  return Promise.resolve().then(fn).then(
    () => console.log(`✓ ${label}`),
    (err) => { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); },
  );
}

/** Fake-KubeConfig: makeApiClient liefert das vorbereitete Antwortobjekt. */
function makeClientStub(responses, opts = {}) {
  const state = { released: 0, built: 0 };
  return {
    _state: state,
    async buildConfig() {
      state.built += 1;
      if (opts.buildThrows) throw new Error('buildConfig kaputt');
      return {
        kc: {
          makeApiClient: () => new Proxy({}, {
            get: (_t, method) => async () => {
              if (opts.apiThrows) throw new Error('cluster weg');
              const hit = responses[String(method)];
              if (hit === undefined) throw new Error(`unerwartete Methode ${String(method)}`);
              return hit;
            },
          }),
        },
        release: () => { state.released += 1; },
      };
    },
  };
}

const clustersStub = { async findById(id) { return { _id: id, defaultNamespace: 'default' }; } };

(async () => {
  await check('Kind-Registry: bekannte Kinds werden erkannt, fremde nicht', () => {
    assert.equal(isKubeKind('Pod'), true);
    assert.equal(isKubeKind('Widget'), false);
    assert.equal(isKubeKind(42), false);
    assert.ok(KUBE_KINDS.length >= 14, 'Registry ist unerwartet klein');
  });

  await check('Kind-Registry: Node und Namespace sind nicht namespaced', () => {
    assert.equal(isNamespaced('Pod'), true);
    assert.equal(isNamespaced('Node'), false);
    assert.equal(isNamespaced('Namespace'), false);
  });

  await check('list() gibt den Transport genau einmal frei', async () => {
    const client = makeClientStub({ listNamespacedPod: { items: [] } });
    const svc = new KubeResourcesService(clustersStub, client);
    await svc.list('c1', 'Pod', { namespace: 'prod' });
    assert.equal(client._state.released, 1, `released=${client._state.released}, erwartet 1`);
  });

  await check('list() gibt auch dann frei, wenn die API wirft', async () => {
    const client = makeClientStub({}, { apiThrows: true });
    const svc = new KubeResourcesService(clustersStub, client);
    await svc.list('c1', 'Pod', { namespace: 'prod' }).then(
      () => { throw new Error('hätte werfen müssen'); },
      () => {},
    );
    assert.equal(client._state.released, 1, `released=${client._state.released}, erwartet 1`);
  });

  await check('scheitert buildConfig, wird nichts freigegeben (es gibt nichts)', async () => {
    const client = makeClientStub({}, { buildThrows: true });
    const svc = new KubeResourcesService(clustersStub, client);
    await svc.list('c1', 'Pod', {}).then(() => { throw new Error('hätte werfen müssen'); }, () => {});
    assert.equal(client._state.released, 0);
  });

  await check('list() ohne Namespace nutzt den All-Namespaces-Aufruf', async () => {
    const client = makeClientStub({ listPodForAllNamespaces: { items: [
      { metadata: { name: 'a', namespace: 'x' }, status: { phase: 'Running' } },
    ] } });
    const svc = new KubeResourcesService(clustersStub, client);
    const rows = await svc.list('c1', 'Pod', {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].namespace, 'x');
  });

  await check('list() liefert projizierte Zeilen, nicht die Rohobjekte', async () => {
    const client = makeClientStub({ listNamespacedPod: { items: [{
      metadata: { name: 'api', namespace: 'prod', managedFields: [{ manager: 'x' }] },
      status: { phase: 'Running', containerStatuses: [{ name: 'c', ready: true, restartCount: 1 }] },
      spec: { nodeName: 'n1', containers: [{ image: 'sehr/gross:1' }] },
    }] } });
    const svc = new KubeResourcesService(clustersStub, client);
    const rows = await svc.list('c1', 'Pod', { namespace: 'prod' });
    assert.equal(rows[0].ready, '1/1');
    assert.equal(rows[0].restarts, 1);
    assert.equal(rows[0].spec, undefined, 'die Rohform ist in die Liste durchgeschlagen');
    assert.equal(JSON.stringify(rows).includes('managedFields'), false);
  });

  await check('get() auf ein Secret liefert nie Werte', async () => {
    const client = makeClientStub({ readNamespacedSecret: {
      kind: 'Secret', metadata: { name: 'db', namespace: 'prod' }, type: 'Opaque',
      data: { password: 'Z2VoZWlt' },
    } });
    const svc = new KubeResourcesService(clustersStub, client);
    const out = await svc.get('c1', 'Secret', 'db', 'prod');
    const json = JSON.stringify(out);
    assert.ok(!json.includes('Z2VoZWlt'), 'Secret-Wert ist durchgekommen');
    assert.ok(json.includes('password'), 'der Key-Name fehlt');
  });

  await check('getYaml() auf ein Secret liefert ebenfalls keine Werte', async () => {
    const client = makeClientStub({ readNamespacedSecret: {
      kind: 'Secret', metadata: { name: 'db', namespace: 'prod' }, data: { password: 'Z2VoZWlt' },
    } });
    const svc = new KubeResourcesService(clustersStub, client);
    const yaml = await svc.getYaml('c1', 'Secret', 'db', 'prod');
    assert.ok(!yaml.includes('Z2VoZWlt'), 'Secret-Wert ist im YAML gelandet');
  });

  await check('get() auf ein Secret OHNE kind/apiVersion liefert trotzdem nie Werte', async () => {
    // Genau die Form, die aus einer Kubernetes-List-Antwort kommt: items[]
    // trägt typischerweise kein eigenes kind/apiVersion. Task 1s toYamlSafe
    // erkennt ein Secret über obj.kind === 'Secret' — das greift hier nicht.
    // Die Redaktion muss also am angefragten Kind hängen, nicht am
    // Rückgabewert des Clusters.
    const client = makeClientStub({ readNamespacedSecret: {
      metadata: { name: 'db', namespace: 'prod' }, type: 'Opaque',
      data: { password: 'Z2VoZWlt' },
    } });
    const svc = new KubeResourcesService(clustersStub, client);
    const out = await svc.get('c1', 'Secret', 'db', 'prod');
    const outJson = JSON.stringify(out);
    assert.ok(!outJson.includes('Z2VoZWlt'), 'get(): Secret-Wert ohne kind/apiVersion ist durchgekommen');

    const client2 = makeClientStub({ readNamespacedSecret: {
      metadata: { name: 'db', namespace: 'prod' }, data: { password: 'Z2VoZWlt' },
    } });
    const svc2 = new KubeResourcesService(clustersStub, client2);
    const yaml = await svc2.getYaml('c1', 'Secret', 'db', 'prod');
    assert.ok(!yaml.includes('Z2VoZWlt'), 'getYaml(): Secret-Wert ohne kind/apiVersion ist im YAML gelandet');
  });

  await check('ein namespaced Kind ohne Namespace bei get() wird abgelehnt', async () => {
    const client = makeClientStub({});
    const svc = new KubeResourcesService(clustersStub, client);
    const err = await svc.get('c1', 'Pod', 'api').then(() => null, (e) => e);
    assert.ok(err, 'hätte werfen müssen');
    assert.equal(err.status, 400);
    assert.equal(client._state.built, 0, 'die Validierung kam zu spät — es wurde schon verbunden');
  });

  await check('ein unbekanntes Kind wird abgelehnt, bevor verbunden wird', async () => {
    const client = makeClientStub({});
    const svc = new KubeResourcesService(clustersStub, client);
    const err = await svc.list('c1', 'Widget', {}).then(() => null, (e) => e);
    assert.ok(err, 'hätte werfen müssen');
    assert.equal(err.status, 400);
    assert.equal(client._state.built, 0);
  });

  await check('limit wird auf einen Höchstwert gedeckelt', async () => {
    let seen = null;
    const client = {
      _state: { released: 0 },
      async buildConfig() {
        return {
          kc: { makeApiClient: () => ({ listNamespacedPod: async (p) => { seen = p; return { items: [] }; } }) },
          release: () => { client._state.released += 1; },
        };
      },
    };
    const svc = new KubeResourcesService(clustersStub, client);
    await svc.list('c1', 'Pod', { namespace: 'prod', limit: 100000 });
    assert.ok(seen.limit <= 500, `limit war ${seen.limit}, erwartet <= 500`);
  });

  console.log('');
  console.log(`Kube resources checks: ${total - failures}/${total} passed`);
  if (failures > 0) process.exit(1);
})();
