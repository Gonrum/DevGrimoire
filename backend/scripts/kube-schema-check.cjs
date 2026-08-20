#!/usr/bin/env node
/*
 * Invarianten-Check für das KubeCluster-Schema (K1, Task 2).
 * Validiert den Pre-Save-Hook gegen konstruierte Dokumente.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { KubeClusterSchema } = loadCompiled('kube/schemas/kube-cluster.schema.js');
const mongoose = loadCompiled('../node_modules/mongoose/index.js');
const { Types } = mongoose;

let failures = 0;
let total = 0;
function check(label, fn) {
  total += 1;
  return Promise.resolve().then(fn).then(
    () => console.log(`✓ ${label}`),
    (err) => { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); },
  );
}

const Model = mongoose.model('KubeClusterCheck', KubeClusterSchema);

function base(overrides) {
  return new Model(Object.assign({
    label: 'Prod',
    slug: 'prod',
    projectId: new Types.ObjectId(),
    kubeconfigSecretId: new Types.ObjectId(),
    contextName: 'prod',
    clusterServer: 'https://prod.example.com:6443',
    transport: 'direct',
    readOnly: true,
    allowMcpWrites: false,
  }, overrides));
}

async function expectInvalid(doc, needle) {
  const err = await doc.validate().then(() => null, (e) => e);
  assert.ok(err, 'Validierung hätte fehlschlagen müssen');
  assert.match(String(err.message), needle);
}

(async () => {
  await check('gültiges Dokument validiert', async () => {
    await base().validate();
  });

  await check('Scope: weder customerId noch projectId ist ungültig', async () => {
    const doc = base();
    doc.projectId = undefined;
    await expectInvalid(doc, /scope/i);
  });

  await check('Scope: beide gesetzt ist ungültig', async () => {
    await expectInvalid(base({ customerId: new Types.ObjectId() }), /scope/i);
  });

  await check('ssh-tunnel ohne sshConnectionId ist ungültig', async () => {
    await expectInvalid(base({ transport: 'ssh-tunnel' }), /sshConnectionId/);
  });

  await check('ssh-tunnel mit sshConnectionId ist gültig', async () => {
    await base({ transport: 'ssh-tunnel', sshConnectionId: new Types.ObjectId() }).validate();
  });

  await check('allowMcpWrites bei readOnly ist ungültig', async () => {
    await expectInvalid(base({ readOnly: true, allowMcpWrites: true }), /allowMcpWrites/);
  });

  await check('prometheus.enabled ohne Service ist ungültig', async () => {
    await expectInvalid(
      base({ prometheus: { enabled: true, namespace: 'monitoring', port: 9090, path: '/' } }),
      /prometheus/,
    );
  });

  await check('Slug muss kebab-case sein', async () => {
    await expectInvalid(base({ slug: 'Prod Cluster' }), /slug/);
  });

  await check('Default ist readOnly', async () => {
    const doc = new Model({
      label: 'X', slug: 'x', projectId: new Types.ObjectId(),
      kubeconfigSecretId: new Types.ObjectId(), contextName: 'x',
      clusterServer: 'https://x:6443', transport: 'direct',
    });
    assert.equal(doc.readOnly, true, 'readOnly muss per Default true sein');
    assert.equal(doc.allowMcpWrites, false, 'allowMcpWrites muss per Default false sein');
  });

  console.log('');
  console.log(`Kube schema checks: ${total - failures}/${total} passed`);
  if (failures > 0) process.exit(1);
})();
