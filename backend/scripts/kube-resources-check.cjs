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

/**
 * Fake-KubeConfig: makeApiClient liefert das vorbereitete Antwortobjekt.
 *
 * Ein Eintrag in `responses` darf auch eine Funktion `(param) => antwort`
 * sein — so kann eine Attrappe die Anfrage-Parameter auswerten, statt sie zu
 * ignorieren. Gebraucht wird das für den `fieldSelector`: ein Stub, der ihn
 * ignoriert, kann nicht zeigen, ob serverseitig oder nachträglich gefiltert
 * wird — genau der Unterschied in Fund I3.
 *
 * Alle gesehenen Parameter landen in `_state.calls`.
 */
function makeClientStub(responses, opts = {}) {
  const state = { released: 0, built: 0, calls: [] };
  return {
    _state: state,
    async buildConfig() {
      state.built += 1;
      if (opts.buildThrows) throw new Error('buildConfig kaputt');
      return {
        kc: {
          makeApiClient: () => new Proxy({}, {
            get: (_t, method) => async (param) => {
              if (opts.apiThrows) throw new Error('cluster weg');
              state.calls.push({ method: String(method), param });
              const hit = responses[String(method)];
              if (hit === undefined) throw new Error(`unerwartete Methode ${String(method)}`);
              return typeof hit === 'function' ? hit(param) : hit;
            },
          }),
        },
        release: () => { state.released += 1; },
      };
    },
  };
}

/**
 * Attrappe eines echten Event-Endpunkts: wendet `fieldSelector` an, BEVOR
 * `limit` greift — so wie ein API-Server es tut. Ein Stub, der stattdessen
 * einfach alles zurückgibt, würde den Unterschied zwischen „serverseitig
 * gefiltert" und „nachträglich gefiltert" verstecken.
 *
 * Unterstützt nur, was hier gebraucht wird: `feld=wert`, komma-getrennt (UND).
 */
function eventEndpoint(items) {
  return (param) => {
    const selector = param && typeof param.fieldSelector === 'string' ? param.fieldSelector : '';
    const conditions = selector
      ? selector.split(',').map((part) => {
        const [field, ...rest] = part.split('=');
        return { field, value: rest.join('=') };
      })
      : [];
    const read = (item, field) => {
      if (field === 'involvedObject.name') return item.involvedObject && item.involvedObject.name;
      if (field === 'involvedObject.kind') return item.involvedObject && item.involvedObject.kind;
      throw new Error(`Attrappe kennt das Feld "${field}" nicht`);
    };
    const matching = items.filter((item) => conditions.every((c) => read(item, c.field) === c.value));
    const limit = param && typeof param.limit === 'number' ? param.limit : matching.length;
    return { items: matching.slice(0, limit) };
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

  await check('getYaml() auf ein Secret zeigt die Key-Namen (Fund B: doppelte Redaktion)', async () => {
    // getYaml() delegiert an get(), das bereits redigiert hat — toYamlSafe
    // redigierte danach ein zweites Mal, fand nichts mehr und produzierte
    // keys: []. Das YAML eines redigierten Secrets sah dann aus wie das eines
    // Secrets ganz ohne Daten.
    const client = makeClientStub({ readNamespacedSecret: {
      kind: 'Secret', apiVersion: 'v1', metadata: { name: 'db', namespace: 'prod' },
      type: 'Opaque', data: { password: 'Z2VoZWlt', username: 'YWRtaW4=' },
    } });
    const svc = new KubeResourcesService(clustersStub, client);
    const yaml = await svc.getYaml('c1', 'Secret', 'db', 'prod');
    assert.ok(!yaml.includes('Z2VoZWlt'), 'Secret-Wert ist im YAML gelandet');
    assert.ok(yaml.includes('password'), `Key-Name "password" fehlt im YAML:\n${yaml}`);
    assert.ok(yaml.includes('username'), `Key-Name "username" fehlt im YAML:\n${yaml}`);
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

  await check('events() projiziert auf schmale Zeilen und sortiert neueste zuerst', async () => {
    const client = makeClientStub({ listNamespacedEvent: { items: [
      { type: 'Normal', reason: 'Pulled', message: 'alt', count: 1,
        lastTimestamp: '2026-08-01T10:00:00Z',
        involvedObject: { kind: 'Pod', name: 'api' }, metadata: { namespace: 'prod' } },
      { type: 'Warning', reason: 'BackOff', message: 'neu', count: 7,
        lastTimestamp: '2026-08-01T12:00:00Z',
        involvedObject: { kind: 'Pod', name: 'api' }, metadata: { namespace: 'prod' } },
    ] } });
    const svc = new KubeResourcesService(clustersStub, client);
    const rows = await svc.events('c1', { namespace: 'prod' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].reason, 'BackOff', 'nicht nach Zeit sortiert');
    assert.equal(rows[0].count, 7);
    assert.equal(rows[0].involvedKind, 'Pod');
    assert.equal(client._state.released, 1);
  });

  await check('events() ohne lastTimestamp wirft nicht', async () => {
    const client = makeClientStub({ listNamespacedEvent: { items: [
      { type: 'Normal', reason: 'X', involvedObject: { kind: 'Pod', name: 'a' } },
    ] } });
    const svc = new KubeResourcesService(clustersStub, client);
    const rows = await svc.events('c1', { namespace: 'prod' });
    assert.equal(rows.length, 1);
  });

  await check('describe() liefert Objekt, Events und Conditions', async () => {
    const client = makeClientStub({
      readNamespacedPod: {
        kind: 'Pod', metadata: { name: 'api', namespace: 'prod' },
        status: { phase: 'Running', conditions: [
          { type: 'Ready', status: 'False', reason: 'ContainersNotReady', message: 'warte' },
        ] },
      },
      // Attrappe mit fieldSelector-Auswertung: das Ausfiltern fremder Events
      // passiert seit Fund I3 serverseitig, nicht mehr nachträglich.
      listNamespacedEvent: eventEndpoint([
        { type: 'Warning', reason: 'BackOff', lastTimestamp: '2026-08-01T12:00:00Z',
          involvedObject: { kind: 'Pod', name: 'api' }, metadata: { namespace: 'prod' } },
        { type: 'Normal', reason: 'Andere', lastTimestamp: '2026-08-01T12:00:00Z',
          involvedObject: { kind: 'Pod', name: 'nicht-api' }, metadata: { namespace: 'prod' } },
      ]),
    });
    const svc = new KubeResourcesService(clustersStub, client);
    const out = await svc.describe('c1', 'Pod', 'api', 'prod');
    assert.equal(out.conditions.length, 1);
    assert.equal(out.conditions[0].reason, 'ContainersNotReady');
    assert.equal(out.events.length, 1, 'Events fremder Objekte wurden nicht ausgefiltert');
    assert.equal(out.events[0].reason, 'BackOff');
  });

  // -------------------------------------------------------------------------
  // Zeitfelder kommen als `Date` (Review-Fund, Critical 1)
  //
  // `@kubernetes/client-node` deserialisiert jedes als `Date` deklarierte Feld
  // über `new Date(data)` (ObjectSerializer.js:2473). Alle Fixtures oben
  // benutzen ISO-Strings und bewiesen deshalb nichts: live fielen
  // `metadata.creationTimestamp`, `lastTimestamp` und `lastTransitionTime`
  // restlos weg (gemessen: 97 von 105 Events ohne Zeitstempel).
  // -------------------------------------------------------------------------
  await check('list() übernimmt ein Date-creationTimestamp als ISO-String', async () => {
    const client = makeClientStub({ listNamespacedPod: { items: [
      { metadata: { name: 'api', namespace: 'prod', creationTimestamp: new Date('2026-08-01T10:00:00.000Z') } },
    ] } });
    const svc = new KubeResourcesService(clustersStub, client);
    const rows = await svc.list('c1', 'Pod', { namespace: 'prod' });
    assert.equal(rows[0].createdAt, '2026-08-01T10:00:00.000Z',
      'createdAt fehlt — die ALTER-Spalte bleibt für jede Zeile leer');
  });

  await check('events() übernimmt ein Date-lastTimestamp und sortiert danach', async () => {
    const client = makeClientStub({ listNamespacedEvent: { items: [
      { type: 'Normal', reason: 'Pulled', lastTimestamp: new Date('2026-08-01T10:00:00.000Z'),
        involvedObject: { kind: 'Pod', name: 'api' }, metadata: { namespace: 'prod' } },
      { type: 'Warning', reason: 'BackOff', lastTimestamp: new Date('2026-08-01T12:00:00.000Z'),
        involvedObject: { kind: 'Pod', name: 'api' }, metadata: { namespace: 'prod' } },
    ] } });
    const svc = new KubeResourcesService(clustersStub, client);
    const rows = await svc.events('c1', { namespace: 'prod' });
    assert.equal(rows[0].lastTimestamp, '2026-08-01T12:00:00.000Z',
      'lastTimestamp fehlt — "neueste zuerst" ist dann eine leere Zusicherung');
    assert.equal(rows[0].reason, 'BackOff', 'ohne Zeitstempel wird nicht sortiert');
    assert.equal(rows[1].lastTimestamp, '2026-08-01T10:00:00.000Z');
  });

  await check('events() nimmt eventTime als Date, wenn lastTimestamp fehlt', async () => {
    const client = makeClientStub({ listNamespacedEvent: { items: [
      { type: 'Normal', reason: 'X', eventTime: new Date('2026-08-01T09:00:00.000Z'),
        involvedObject: { kind: 'Pod', name: 'api' } },
    ] } });
    const svc = new KubeResourcesService(clustersStub, client);
    const rows = await svc.events('c1', { namespace: 'prod' });
    assert.equal(rows[0].lastTimestamp, '2026-08-01T09:00:00.000Z');
  });

  await check('describe(): lastTransitionTime als Date überlebt die Projektion', async () => {
    const client = makeClientStub({
      readNamespacedPod: {
        kind: 'Pod', metadata: { name: 'api', namespace: 'prod' },
        status: { phase: 'Pending', conditions: [
          { type: 'Ready', status: 'False', reason: 'ContainersNotReady',
            lastTransitionTime: new Date('2026-08-01T11:30:00.000Z') },
        ] },
      },
      listNamespacedEvent: { items: [] },
    });
    const svc = new KubeResourcesService(clustersStub, client);
    const out = await svc.describe('c1', 'Pod', 'api', 'prod');
    assert.equal(out.conditions[0].lastTransitionTime, '2026-08-01T11:30:00.000Z',
      'ohne lastTransitionTime kann ein Agent nicht sagen, ob "Ready: False" fünf Sekunden oder fünf Tage alt ist');
  });

  // -------------------------------------------------------------------------
  // Events serverseitig filtern statt nachträglich (Review-Fund I3)
  //
  // `fetchEvents` holte `limit` Events (Default 200) und filterte DANACH auf
  // `involvedName`. Bei mehr als `limit` Events im Namespace stehen die
  // geholten in etcd-Schlüsselreihenfolge, nicht in Zeitreihenfolge — das
  // gesuchte Objekt ist dann sehr wahrscheinlich nicht dabei, und describe
  // meldet „keine Events", während sie existieren. Lautlos, und genau
  // während des Vorfalls, für den das Werkzeug da ist.
  // -------------------------------------------------------------------------
  await check('events(involvedName) schickt einen fieldSelector statt nachträglich zu filtern', async () => {
    const client = makeClientStub({ listNamespacedEvent: eventEndpoint([]) });
    const svc = new KubeResourcesService(clustersStub, client);
    await svc.events('c1', { namespace: 'prod', involvedName: 'api' });
    const call = client._state.calls.find((c) => c.method === 'listNamespacedEvent');
    assert.ok(call, 'listNamespacedEvent wurde nie aufgerufen');
    assert.equal(call.param.fieldSelector, 'involvedObject.name=api',
      `fieldSelector war ${JSON.stringify(call.param.fieldSelector)}`);
  });

  await check('events() ohne involvedName schickt gar keinen fieldSelector', async () => {
    const client = makeClientStub({ listNamespacedEvent: eventEndpoint([]) });
    const svc = new KubeResourcesService(clustersStub, client);
    await svc.events('c1', { namespace: 'prod' });
    const call = client._state.calls.find((c) => c.method === 'listNamespacedEvent');
    assert.equal(call.param.fieldSelector, undefined);
  });

  await check('describe() schickt Name UND Kind als fieldSelector', async () => {
    const client = makeClientStub({
      readNamespacedPod: { kind: 'Pod', metadata: { name: 'api', namespace: 'prod' } },
      listNamespacedEvent: eventEndpoint([]),
    });
    const svc = new KubeResourcesService(clustersStub, client);
    await svc.describe('c1', 'Pod', 'api', 'prod');
    const call = client._state.calls.find((c) => c.method === 'listNamespacedEvent');
    assert.equal(call.param.fieldSelector, 'involvedObject.name=api,involvedObject.kind=Pod',
      `fieldSelector war ${JSON.stringify(call.param.fieldSelector)} — ohne involvedObject.kind teilen sich ein Deployment, ein Service und ein Ingress namens "api" ihre Events`);
  });

  await check('describe() findet die Events auch, wenn der Namespace mehr als `limit` Events hat', async () => {
    // Der eigentliche Fund: 300 fremde Events VOR dem gesuchten, Default-Limit
    // 200. Fetch-then-filter liefert 0 Treffer; serverseitig gefiltert
    // kommen die richtigen zurück.
    const noise = [];
    for (let i = 0; i < 300; i += 1) {
      noise.push({
        type: 'Normal', reason: `Rauschen${i}`, lastTimestamp: new Date('2026-08-01T09:00:00.000Z'),
        involvedObject: { kind: 'Pod', name: `anderer-pod-${i}` }, metadata: { namespace: 'prod' },
      });
    }
    noise.push({
      type: 'Warning', reason: 'BackOff', lastTimestamp: new Date('2026-08-01T12:00:00.000Z'),
      involvedObject: { kind: 'Pod', name: 'api' }, metadata: { namespace: 'prod' },
    });
    const client = makeClientStub({
      readNamespacedPod: { kind: 'Pod', metadata: { name: 'api', namespace: 'prod' } },
      listNamespacedEvent: eventEndpoint(noise),
    });
    const svc = new KubeResourcesService(clustersStub, client);
    const out = await svc.describe('c1', 'Pod', 'api', 'prod');
    assert.equal(out.events.length, 1,
      'die Events des beschriebenen Objekts lagen ausserhalb des geholten Fensters');
    assert.equal(out.events[0].reason, 'BackOff');
  });

  await check('describe() trennt gleichnamige Objekte verschiedener Kinds', async () => {
    const shared = [
      { type: 'Warning', reason: 'PodEvent', lastTimestamp: new Date('2026-08-01T12:00:00.000Z'),
        involvedObject: { kind: 'Pod', name: 'api' }, metadata: { namespace: 'prod' } },
      { type: 'Warning', reason: 'ServiceEvent', lastTimestamp: new Date('2026-08-01T12:00:00.000Z'),
        involvedObject: { kind: 'Service', name: 'api' }, metadata: { namespace: 'prod' } },
    ];
    const client = makeClientStub({
      readNamespacedService: { kind: 'Service', metadata: { name: 'api', namespace: 'prod' } },
      listNamespacedEvent: eventEndpoint(shared),
    });
    const svc = new KubeResourcesService(clustersStub, client);
    const out = await svc.describe('c1', 'Service', 'api', 'prod');
    assert.deepEqual(out.events.map((e) => e.reason), ['ServiceEvent']);
  });

  await check('ein Name mit Komma/Gleichheitszeichen wird im fieldSelector maskiert', async () => {
    const client = makeClientStub({ listNamespacedEvent: eventEndpoint([]) });
    const svc = new KubeResourcesService(clustersStub, client);
    await svc.events('c1', { namespace: 'prod', involvedName: 'a,b=c' });
    const call = client._state.calls.find((c) => c.method === 'listNamespacedEvent');
    assert.equal(call.param.fieldSelector, 'involvedObject.name=a\\,b\\=c',
      'ein unmaskierter Wert würde als zweite Bedingung gelesen');
  });

  await check('describe() gibt den Transport genau einmal frei', async () => {
    const client = makeClientStub({
      readNamespacedPod: { kind: 'Pod', metadata: { name: 'api', namespace: 'prod' } },
      listNamespacedEvent: { items: [] },
    });
    const svc = new KubeResourcesService(clustersStub, client);
    await svc.describe('c1', 'Pod', 'api', 'prod');
    assert.equal(client._state.released, 1,
      `released=${client._state.released} — describe() macht zwei Abfragen, darf aber nur einmal freigeben`);
  });

  console.log('');
  console.log(`Kube resources checks: ${total - failures}/${total} passed`);
  if (failures > 0) process.exit(1);
})();
