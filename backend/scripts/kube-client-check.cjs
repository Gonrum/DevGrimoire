#!/usr/bin/env node
/*
 * Check für KubeClientService (K1, Task 5). Der Cluster-Zugriff wird
 * gestubbt — geprüft wird die Verdrahtung: Transport wird freigegeben,
 * Fehler landen als lastConnectError, Verben werden korrekt ausgewertet.
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

const { deriveCanWrite } = loadCompiled('kube/kube-client.service.js');

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

check('nur lesende Verben ergeben canWrite=false', () => {
  const out = deriveCanWrite([{ verbs: ['get', 'list', 'watch'], resources: ['pods'] }]);
  assert.equal(out.canWrite, false);
  assert.deepEqual(out.verbs.sort(), ['get', 'list', 'watch']);
});

check('create/update/delete ergeben canWrite=true', () => {
  assert.equal(deriveCanWrite([{ verbs: ['get', 'delete'], resources: ['pods'] }]).canWrite, true);
});

check('Wildcard-Verb ergibt canWrite=true', () => {
  assert.equal(deriveCanWrite([{ verbs: ['*'], resources: ['*'] }]).canWrite, true);
});

check('leere Regelliste ergibt canWrite=false', () => {
  assert.equal(deriveCanWrite([]).canWrite, false);
});

check('Verben werden dedupliziert', () => {
  const out = deriveCanWrite([{ verbs: ['get'] }, { verbs: ['get', 'list'] }]);
  assert.deepEqual(out.verbs.sort(), ['get', 'list']);
});

console.log('');
console.log(`Kube client checks: ${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
