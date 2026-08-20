#!/usr/bin/env node
/*
 * Pure-logic check für den Kubeconfig-Parser (K1, Task 1).
 * Lädt kompilierte Artefakte aus dist/. Vorher `npm run build`.
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

const { parseKubeconfig } = loadCompiled('kube/kubeconfig-parser.js');

let failures = 0;
let total = 0;
function check(label, fn) {
  total += 1;
  try {
    fn();
    console.log(`✓ ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
  }
}

const GOOD = `
apiVersion: v1
kind: Config
current-context: prod
contexts:
  - name: prod
    context: { cluster: prod-cluster, user: prod-user, namespace: default }
  - name: staging
    context: { cluster: staging-cluster, user: staging-user }
clusters:
  - name: prod-cluster
    cluster:
      server: https://prod.example.com:6443
      certificate-authority-data: Zm9v
  - name: staging-cluster
    cluster:
      server: https://staging.example.com:6443
      insecure-skip-tls-verify: true
users:
  - name: prod-user
    user: { token: sekret }
  - name: staging-user
    user: { token: sekret2 }
`;

const EXEC_PLUGIN = `
apiVersion: v1
kind: Config
current-context: eks
contexts:
  - name: eks
    context: { cluster: eks-cluster, user: eks-user }
clusters:
  - name: eks-cluster
    cluster:
      server: https://eks.example.com
      certificate-authority-data: Zm9v
users:
  - name: eks-user
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: aws
        args: [eks, get-token]
`;

check('listet alle Contexts mit Server-URL', () => {
  const parsed = parseKubeconfig(GOOD);
  assert.equal(parsed.contexts.length, 2);
  assert.equal(parsed.currentContext, 'prod');
  const prod = parsed.contexts.find((c) => c.contextName === 'prod');
  assert.equal(prod.server, 'https://prod.example.com:6443');
  assert.equal(prod.namespace, 'default');
  assert.deepEqual(prod.warnings, []);
});

check('meldet insecure-skip-tls-verify als Warnung', () => {
  const staging = parseKubeconfig(GOOD).contexts.find((c) => c.contextName === 'staging');
  assert.ok(staging.warnings.includes('insecure_tls'), 'insecure_tls fehlt');
});

check('meldet fehlende CA als Warnung', () => {
  const staging = parseKubeconfig(GOOD).contexts.find((c) => c.contextName === 'staging');
  assert.ok(staging.warnings.includes('no_ca'), 'no_ca fehlt');
});

check('lehnt Exec-Credential-Plugins ab', () => {
  const eks = parseKubeconfig(EXEC_PLUGIN).contexts[0];
  assert.ok(eks.rejections.includes('exec_plugin'), 'exec_plugin fehlt');
});

check('gibt NIEMALS Credentials zurück', () => {
  const json = JSON.stringify(parseKubeconfig(GOOD));
  assert.ok(!json.includes('sekret'), 'Token ist in der Ausgabe gelandet');
  assert.ok(!json.includes('Zm9v'), 'CA-Daten sind in der Ausgabe gelandet');
});

check('wirft "unparsable" bei Müll', () => {
  assert.throws(() => parseKubeconfig(':::nope:::'), /unparsable/);
});

console.log('');
console.log(`Kubeconfig parser checks: ${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
