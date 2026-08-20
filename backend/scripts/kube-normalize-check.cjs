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

const { stripHeavyMetadata, projectRow, redactSecret, toYamlSafe } =
  loadCompiled('kube/kube-normalize.js');

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

check('toYamlSafe strippt vorher und liefert lesbares YAML', () => {
  const yaml = toYamlSafe(POD);
  assert.ok(yaml.includes('name: api-7d9f'));
  assert.ok(!yaml.includes('managedFields'), 'managedFields sind im YAML gelandet');
  assert.ok(!yaml.includes('last-applied-configuration'), 'last-applied ist im YAML gelandet');
});

console.log('');
console.log(`Kube normalize checks: ${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
