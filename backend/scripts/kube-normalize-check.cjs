#!/usr/bin/env node
/*
 * Pure-logic check für die Kube-Normalisierung (K2, Task 1).
 * Diese Schicht ist die einzige Stelle, an der Cluster-Objekte für UI und
 * MCP aufbereitet werden — sie ist damit sowohl Kontext-Budget als auch
 * Sicherheitsgrenze (Secrets). Lädt aus dist/; vorher `npm run build`.
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

const {
  stripHeavyMetadata, projectRow, redactSecret, toYamlSafe,
  isKubeNameLabel, isKubeNameSubdomain,
  KUBE_NAME_LABEL_MAX, KUBE_NAME_SUBDOMAIN_MAX,
} = loadCompiled('kube/kube-normalize.js');

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const POD = {
  apiVersion: 'v1', kind: 'Pod',
  metadata: {
    name: 'api-7d9f', namespace: 'prod',
    creationTimestamp: '2026-08-01T10:00:00Z',
    managedFields: [{ manager: 'kubectl', operation: 'Apply', fieldsV1: { 'f:spec': {} } }],
    annotations: {
      'kubectl.kubernetes.io/last-applied-configuration': '{"huge":"blob"}',
      'app.example/owner': 'team-a',
      'app.example/long': 'x'.repeat(1000),
    },
  },
  spec: { nodeName: 'node-3' },
  status: {
    phase: 'Running',
    containerStatuses: [
      { name: 'api', ready: true, restartCount: 2 },
      { name: 'sidecar', ready: false, restartCount: 0 },
    ],
  },
};

check('managedFields werden entfernt', () => {
  const out = stripHeavyMetadata(POD);
  assert.equal(out.metadata.managedFields, undefined);
});

check('last-applied-configuration wird entfernt', () => {
  const out = stripHeavyMetadata(POD);
  assert.equal(out.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'], undefined);
});

check('normale Annotations bleiben, lange werden gekürzt', () => {
  const out = stripHeavyMetadata(POD);
  assert.equal(out.metadata.annotations['app.example/owner'], 'team-a');
  assert.ok(out.metadata.annotations['app.example/long'].length < 300,
    'lange Annotation wurde nicht gekürzt');
});

check('das Original wird nicht mutiert', () => {
  stripHeavyMetadata(POD);
  assert.ok(Array.isArray(POD.metadata.managedFields),
    'stripHeavyMetadata hat sein Eingabeobjekt verändert');
});

check('Pod-Projektion liefert ready, restarts, node, status', () => {
  const row = projectRow('Pod', POD);
  assert.equal(row.name, 'api-7d9f');
  assert.equal(row.namespace, 'prod');
  assert.equal(row.ready, '1/2');
  assert.equal(row.restarts, 2);
  assert.equal(row.node, 'node-3');
  assert.equal(row.status, 'Running');
});

check('Deployment-Projektion liefert ready aus den Replicas', () => {
  const row = projectRow('Deployment', {
    kind: 'Deployment',
    metadata: { name: 'api', namespace: 'prod', creationTimestamp: '2026-08-01T10:00:00Z' },
    status: { readyReplicas: 2, replicas: 3 },
  });
  assert.equal(row.ready, '2/3');
});

check('Deployment ohne readyReplicas ergibt 0/N statt undefined', () => {
  const row = projectRow('Deployment', {
    kind: 'Deployment',
    metadata: { name: 'api', namespace: 'prod' },
    status: { replicas: 3 },
  });
  assert.equal(row.ready, '0/3');
});

// ---------------------------------------------------------------------------
// Zeitfelder kommen als `Date`, nicht als String (Review-Fund, Critical 1)
//
// `@kubernetes/client-node` deserialisiert JEDES Feld, das seine Modelle als
// `Date` deklarieren, über `new Date(data)` (ObjectSerializer.js:2473) —
// `metadata.creationTimestamp`, `lastTimestamp`, `lastTransitionTime`. Die
// Fixtures dieses Checks benutzten bis hierher ausschliesslich ISO-Strings und
// bewiesen damit nichts über den echten Datenfluss: `typeof aDate === 'object'`,
// die Felder fielen live restlos weg. Jede Fixture unten konstruiert deshalb
// ein ECHTES `Date`.
// ---------------------------------------------------------------------------

const CREATED = new Date('2026-08-01T10:00:00.000Z');

check('projectRow liest creationTimestamp als Date (nicht nur als String)', () => {
  const row = projectRow('Pod', {
    metadata: { name: 'api', namespace: 'prod', creationTimestamp: CREATED },
  });
  assert.equal(row.createdAt, '2026-08-01T10:00:00.000Z',
    'ein Date-Zeitstempel wurde verworfen — die ALTER-Spalte bleibt für JEDE Zeile leer');
});

check('projectRow liest creationTimestamp weiterhin als String', () => {
  const row = projectRow('Pod', {
    metadata: { name: 'api', namespace: 'prod', creationTimestamp: '2026-08-01T10:00:00Z' },
  });
  assert.equal(row.createdAt, '2026-08-01T10:00:00Z');
});

check('ein ungültiges Date ergibt undefined statt eines Wurfs', () => {
  // `new Date('kaputt').toISOString()` wirft RangeError — ohne Guard nähme
  // ein einziges kaputtes Objekt die ganze Liste mit.
  const row = projectRow('Pod', {
    metadata: { name: 'api', creationTimestamp: new Date('kaputt') },
  });
  assert.equal(row.createdAt, undefined);
});

check('toYamlSafe überlebt ein Date im Objekt', () => {
  const yaml = toYamlSafe({
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: 'api', namespace: 'prod', creationTimestamp: CREATED },
  });
  assert.ok(yaml.includes('2026-08-01T10:00:00'), `Zeitstempel fehlt im YAML:\n${yaml}`);
});

check('Event-Projektion liefert Typ, Reason und Message (Fund I5)', () => {
  // `Event` steht seit Task 7 im Ressourcenbaum, hatte aber kein `case` in
  // projectRow — die Liste zeigte generierte Namen und sonst nichts.
  const row = projectRow('Event', {
    metadata: { name: 'api.18cdbed6', namespace: 'prod', creationTimestamp: CREATED },
    type: 'Warning',
    reason: 'BackOff',
    message: 'Back-off restarting failed container',
    count: 7,
    involvedObject: { kind: 'Pod', name: 'api-7d9f' },
  });
  assert.equal(row.status, 'Warning', 'ohne Typ ist ein Warning nicht von Normal zu unterscheiden');
  assert.equal(row.detail, 'BackOff');
  assert.equal(row.message, 'Back-off restarting failed container');
  assert.equal(row.createdAt, '2026-08-01T10:00:00.000Z');
});

check('Event-Projektion kürzt eine überlange Message', () => {
  const row = projectRow('Event', {
    metadata: { name: 'e', namespace: 'prod' }, type: 'Normal',
    reason: 'X', message: 'y'.repeat(5000),
  });
  // 300 Zeichen + das angehängte „…"
  assert.ok(row.message.length <= 301, `Message war ${row.message.length} Zeichen lang`);
  assert.ok(row.message.endsWith('…'), 'die Kürzung ist nicht erkennbar');
});

check('unbekanntes Kind ergibt trotzdem Name und Namespace', () => {
  const row = projectRow('Widget', { metadata: { name: 'w', namespace: 'ns' } });
  assert.equal(row.name, 'w');
  assert.equal(row.namespace, 'ns');
});

check('Projektion überlebt ein Objekt ohne metadata', () => {
  const row = projectRow('Pod', {});
  assert.equal(typeof row.name, 'string');
});

check('redactSecret entfernt data und stringData, behält die Key-Namen', () => {
  const out = redactSecret({
    kind: 'Secret',
    metadata: { name: 'db', namespace: 'prod' },
    type: 'Opaque',
    data: { password: 'c3VwZXJnZWhlaW0=', username: 'YWRtaW4=' },
    stringData: { extra: 'plaintext' },
  });
  assert.equal(out.data, undefined);
  assert.equal(out.stringData, undefined);
  assert.deepEqual(out.keys.sort(), ['extra', 'password', 'username']);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('c3VwZXJnZWhlaW0='), 'Secret-Wert ist in der Ausgabe gelandet');
  assert.ok(!json.includes('plaintext'), 'stringData-Wert ist in der Ausgabe gelandet');
});

check('redactSecret verkraftet ein Secret ganz ohne data', () => {
  const out = redactSecret({ kind: 'Secret', metadata: { name: 'leer' }, type: 'Opaque' });
  assert.deepEqual(out.keys, []);
});

check('redactSecret ist idempotent — ein zweiter Lauf verliert die Key-Namen nicht', () => {
  // Review-Fund B: `getYaml()` delegiert an `get()`, das für ein Secret schon
  // `redactSecret` angewandt hat; `toYamlSafe` sieht `kind: 'Secret'` und
  // redigiert ein ZWEITES Mal. Der zweite Lauf fand weder `data` noch
  // `stringData` und produzierte `keys: []` — `withRedactedKeysAnnotation`
  // steigt bei leerer Liste aus, und ein redigiertes Secret wurde im YAML
  // ununterscheidbar von einem Secret ganz ohne Daten. Kein Leck, aber genau
  // die Transparenz, für die redactSecret existiert.
  const once = redactSecret({
    kind: 'Secret', metadata: { name: 'db' }, type: 'Opaque',
    data: { password: 'Z2VoZWlt', username: 'YWRtaW4=' },
  });
  const twice = redactSecret(once);
  assert.deepEqual(twice.keys.sort(), ['password', 'username'],
    'der zweite Lauf hat die Key-Namen verworfen');
  assert.equal(twice.data, undefined);
  assert.ok(!JSON.stringify(twice).includes('Z2VoZWlt'));
});

check('redactSecret übernimmt keys NICHT, wenn data vorhanden ist', () => {
  // Die Übernahme darf nur greifen, wenn es nichts zu redigieren GIBT —
  // sonst könnte ein vom Cluster mitgeliefertes `keys`-Feld die echten
  // Key-Namen überstimmen.
  const out = redactSecret({
    kind: 'Secret', keys: ['erfunden'], data: { echt: 'Z2VoZWlt' },
  });
  assert.deepEqual(out.keys, ['echt']);
});

check('redactSecret ignoriert ein keys-Feld, das kein string[] ist', () => {
  const out = redactSecret({ kind: 'Secret', keys: 'nicht-array' });
  assert.deepEqual(out.keys, []);
  const mixed = redactSecret({ kind: 'Secret', keys: ['ok', 42] });
  assert.deepEqual(mixed.keys, []);
});

check('toYamlSafe eines BEREITS redigierten Secrets zeigt die Key-Namen (Fund B)', () => {
  const redacted = redactSecret({
    kind: 'Secret', apiVersion: 'v1', metadata: { name: 'db', namespace: 'prod' },
    type: 'kubernetes.io/tls', data: { 'tls.crt': 'Y3J0', 'tls.key': 'a2V5' },
  });
  const yaml = toYamlSafe(redacted);
  assert.ok(yaml.includes('tls.crt'), `Key-Name "tls.crt" fehlt im YAML:\n${yaml}`);
  assert.ok(yaml.includes('tls.key'), `Key-Name "tls.key" fehlt im YAML:\n${yaml}`);
  assert.ok(!yaml.includes('Y3J0'), 'Secret-Wert ist im YAML gelandet');
});

check('toYamlSafe strippt vorher und liefert lesbares YAML', () => {
  const yaml = toYamlSafe(POD);
  assert.ok(yaml.includes('name: api-7d9f'));
  assert.ok(!yaml.includes('managedFields'), 'managedFields sind im YAML gelandet');
  assert.ok(!yaml.includes('last-applied-configuration'), 'last-applied ist im YAML gelandet');
});

const SECRET = {
  kind: 'Secret', apiVersion: 'v1',
  metadata: { name: 'db', namespace: 'prod', creationTimestamp: '2026-08-01T10:00:00Z' },
  type: 'Opaque',
  data: { password: 'c3VwZXJnZWhlaW0=', username: 'YWRtaW4=' },
  stringData: { extra: 'plaintext' },
};

check('toYamlSafe: wohlgeformtes Secret enthält keine Werte', () => {
  const yaml = toYamlSafe(SECRET);
  assert.ok(!yaml.includes('c3VwZXJnZWhlaW0='), 'Secret-Wert (data) ist im YAML gelandet');
  assert.ok(!yaml.includes('YWRtaW4='), 'Secret-Wert (data) ist im YAML gelandet');
  assert.ok(!yaml.includes('plaintext'), 'Secret-Wert (stringData) ist im YAML gelandet');
});

check('toYamlSafe: wohlgeformtes Secret zeigt trotzdem die Key-Namen', () => {
  const yaml = toYamlSafe(SECRET);
  assert.ok(yaml.includes('password'), 'Key-Name "password" ist aus dem YAML verschwunden (dumpYaml filtert unbekannte Felder wie `keys` gegen V1Secret weg)');
  assert.ok(yaml.includes('username'), 'Key-Name "username" ist aus dem YAML verschwunden');
  assert.ok(yaml.includes('extra'), 'Key-Name "extra" ist aus dem YAML verschwunden');
});

check('toYamlSafe(null) wirft nicht', () => {
  assert.doesNotThrow(() => toYamlSafe(null));
});

check('toYamlSafe(undefined) wirft nicht', () => {
  assert.doesNotThrow(() => toYamlSafe(undefined));
});

// ---------------------------------------------------------------------------
// RFC-1123-Namensprüfung (Review-Fund C-1, 2026-10-11)
//
// `Log.log()` aus @kubernetes/client-node interpoliert namespace/pod UNCODIERT
// in den URL-Pfad — im Gegensatz zu jeder generierten API-Methode, die
// `encodeURIComponent` nutzt. Diese Prädikate sind die einzige Verteidigung
// dagegen; DTOs und die Logs-Senke teilen sie sich.
// ---------------------------------------------------------------------------

/** Die konkreten Payloads aus dem Review — müssen von BEIDEN Prädikaten abprallen. */
const INJECTIONS = [
  'default/../../../../api/v1/namespaces/kube-system/secrets/registry-pull?x=',
  '../../../api/v1/namespaces/kube-system/secrets/foo',
  'prod?limit=1',
  'prod#frag',
  'prod/x',
  'a b',
];

check('isKubeNameLabel: gültige DNS-1123-Labels', () => {
  assert.equal(KUBE_NAME_LABEL_MAX, 63, 'LABEL_MAX muss 63 sein (Kubernetes-Grenze)');
  for (const ok of ['prod', 'kube-system', 'default', 'a', 'ns1', 'a-b-c', '0', 'abc123']) {
    assert.equal(isKubeNameLabel(ok), true, `"${ok}" ist ein gültiges Label`);
  }
  assert.equal(isKubeNameLabel('a'.repeat(63)), true, '63 Zeichen sind erlaubt');
});

check('isKubeNameLabel: ungültige Labels', () => {
  for (const bad of ['', '-a', 'a-', '.a', 'a.', 'a.b', 'A', 'aBc', 'a_b', 'a b', 'ä', 'a'.repeat(64)]) {
    assert.equal(isKubeNameLabel(bad), false, `"${bad}" hätte abgelehnt werden müssen`);
  }
});

check('isKubeNameLabel: Nicht-Strings werden abgelehnt', () => {
  for (const bad of [undefined, null, 42, {}, [], true, Symbol('x')]) {
    assert.equal(isKubeNameLabel(bad), false, `${String(bad)} hätte abgelehnt werden müssen`);
  }
});

check('isKubeNameSubdomain: gültige DNS-1123-Subdomains (Punkte erlaubt)', () => {
  assert.equal(KUBE_NAME_SUBDOMAIN_MAX, 253, 'SUBDOMAIN_MAX muss 253 sein (Kubernetes-Grenze)');
  for (const ok of ['a', 'pod-1', 'coredns-5d78c9869d-abcde', 'a.b', 'a.b.c', 'ns1.svc.cluster.local']) {
    assert.equal(isKubeNameSubdomain(ok), true, `"${ok}" ist eine gültige Subdomain`);
  }
  const long = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(60)}`;
  assert.ok(long.length <= 253, 'Testannahme verletzt');
  assert.equal(isKubeNameSubdomain(long), true, 'eine 253-Zeichen-Subdomain ist erlaubt');
});

check('isKubeNameSubdomain: ungültige Subdomains', () => {
  for (const bad of ['', '.a', 'a.', 'a..b', '-a', 'a-', 'A', 'a_b', 'a b', 'ä', 'a'.repeat(254)]) {
    assert.equal(isKubeNameSubdomain(bad), false, `"${bad}" hätte abgelehnt werden müssen`);
  }
});

check('isKubeNameSubdomain: Nicht-Strings werden abgelehnt', () => {
  for (const bad of [undefined, null, 42, {}, [], true]) {
    assert.equal(isKubeNameSubdomain(bad), false, `${String(bad)} hätte abgelehnt werden müssen`);
  }
});

check('beide Prädikate lehnen die Review-Injection-Payloads ab', () => {
  for (const payload of INJECTIONS) {
    assert.equal(isKubeNameLabel(payload), false, `Label-Prüfung ließ "${payload}" durch`);
    assert.equal(isKubeNameSubdomain(payload), false, `Subdomain-Prüfung ließ "${payload}" durch`);
  }
});

check('die Payload aus dem Review-PoC ergibt encodiert einen anderen Pfad', () => {
  // Belegt den Kern des Fundes: roh interpoliert trifft die Injection ein
  // fremdes Objekt, encodiert (wie die generierten APIs es tun) nicht.
  const payload = INJECTIONS[0];
  const server = 'https://127.0.0.1:6443';
  const raw = new URL(`${server}/api/v1/namespaces/${payload}/pods/y/log`);
  const encoded = new URL(
    `${server}/api/v1/namespaces/${encodeURIComponent(payload)}/pods/y/log`,
  );
  assert.equal(raw.pathname, '/api/v1/namespaces/kube-system/secrets/registry-pull',
    'PoC-Annahme: roh interpoliert landet die Injection auf einem Secret-Pfad');
  assert.ok(encoded.pathname.includes('default%2F..'),
    'encodiert bleibt die Injection ein einziges (ungültiges) Pfadsegment');
  assert.notEqual(raw.pathname, encoded.pathname);
});

console.log('');
console.log(`Kube normalize checks: ${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
