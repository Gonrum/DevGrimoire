#!/usr/bin/env node
/*
 * Check für KubeClientService (K1, Task 5). Der Cluster-Zugriff wird
 * gestubbt — geprüft wird die Verdrahtung: Transport wird freigegeben,
 * Fehler landen als lastConnectError, Verben werden korrekt ausgewertet.
 *
 * Deckt zusätzlich die beiden Fundstellen aus dem Abschluss-Review von K1 ab:
 *   I6 — test() darf die rohe Kubeconfig nirgends echoen (Kanarienvogel),
 *   I4 — der Verbindungsfehler muss die Ursache nennen, nicht nur "fetch failed".
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

const { deriveCanWrite, KubeClientService } = loadCompiled('kube/kube-client.service.js');
const { errorMessageWithCause } = loadCompiled('common/narrow.js');

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const asyncChecks = [];
function checkAsync(label, fn) {
  asyncChecks.push(async () => {
    total += 1;
    try { await fn(); console.log(`✓ ${label}`); }
    catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
  });
}

// ---------------------------------------------------------------------------
// Stubs für die Verdrahtung von test()
// ---------------------------------------------------------------------------
const CANARY = 'MARKER_SHOULD_NOT_LEAK';
// Absichtlich unparsbares YAML (unterminierte Flow-Sequenz). js-yaml zitiert
// in seiner Fehlermeldung typischerweise einen Ausschnitt des rohen Inputs —
// und der Input ist hier die Kubeconfig, also Credential-Material.
const MALFORMED_KUBECONFIG = `not: [valid, yaml ${CANARY}`;

function goodKubeconfig(server) {
  return [
    'apiVersion: v1', 'kind: Config', 'current-context: prod',
    'contexts:', '  - name: prod',
    '    context: { cluster: c, user: u }',
    'clusters:', '  - name: c',
    `    cluster: { server: "${server}", insecure-skip-tls-verify: true }`,
    'users:', '  - name: u', `    user: { token: ${CANARY}-token }`,
  ].join('\n');
}

function makeClustersStub(kubeconfig) {
  const cluster = {
    _id: 'cluster-1', label: 'Prod', contextName: 'prod',
    defaultNamespace: 'default', transport: 'direct',
    clusterServer: 'https://127.0.0.1:1',
  };
  const calls = { connectError: [], connectSuccess: [] };
  return {
    _calls: calls,
    _cluster: cluster,
    async findById() { return cluster; },
    async readKubeconfig() { return kubeconfig; },
    async recordConnectSuccess(id) { calls.connectSuccess.push(String(id)); },
    async recordConnectError(id, message) { calls.connectError.push({ id: String(id), message }); },
  };
}

function makeTransportStub(url = 'https://127.0.0.1:1') {
  const state = { released: 0, resolved: 0 };
  return {
    _state: state,
    async resolve() {
      state.resolved += 1;
      return { url, servername: 'prod.example.com', release: () => { state.released += 1; } };
    },
  };
}

function makeAuditStub() {
  const rows = [];
  return { _rows: rows, async record(row) { rows.push(row); } };
}

/**
 * Ein Port, auf dem garantiert niemand horcht — ECONNREFUSED ohne Wartezeit.
 * NICHT Port 1: undicis fetch() lehnt eine feste Liste "böser" Ports (u.a. 1,
 * den tcpmux-Port) schon vor dem Verbindungsversuch mit der Ursache
 * "bad port" ab — das verdeckt genau die ECONNREFUSED-Kette, die dieser
 * Check sehen will. 39999 steht auf keiner der bekannten Sperrlisten.
 */
const CLOSED_PORT_URL = 'https://127.0.0.1:39999';

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

// ---------------------------------------------------------------------------
// I6 — test() darf die rohe Kubeconfig nirgends echoen
// ---------------------------------------------------------------------------

checkAsync('test(): ein kaputtes Kubeconfig echot keinen Rohtext in Response, lastConnectError oder Audit', async () => {
  // buildConfig() rief kc.loadFromString(raw) INNERHALB des grossen try auf.
  // Die js-yaml-Fehlermeldung zitiert einen Ausschnitt des Inputs — und die
  // floss von dort in logger.warn, in recordConnectError (persistiert, im UI
  // sichtbar) und zurück an den Aufrufer. Die parse-Route weigert sich
  // bereits, genau das zu tun (kube.controller.ts + kube-cluster-e2e.sh).
  // Erreichbar, weil die Kubeconfig ein gewöhnliches Secret ist und
  // PUT /api/secrets/:id ihren Inhalt ersetzen kann.
  const clusters = makeClustersStub(MALFORMED_KUBECONFIG);
  const transport = makeTransportStub();
  const audit = makeAuditStub();
  const svc = new KubeClientService(clusters, transport, audit);

  const result = await svc.test('cluster-1', 'user-1');

  assert.equal(result.ok, false, 'kaputtes Kubeconfig hätte fehlschlagen müssen');
  assert.ok(!String(result.error).includes(CANARY), `Kubeconfig-Rohtext in der Response: ${result.error}`);
  assert.equal(clusters._calls.connectError.length, 1, 'kein lastConnectError geschrieben');
  assert.ok(
    !String(clusters._calls.connectError[0].message).includes(CANARY),
    `Kubeconfig-Rohtext in lastConnectError (persistiert!): ${clusters._calls.connectError[0].message}`,
  );
  assert.equal(audit._rows.length, 1, 'keine Audit-Zeile geschrieben');
  assert.ok(!String(audit._rows[0].errorMsg).includes(CANARY), 'Kubeconfig-Rohtext in der Audit-Zeile');
  assert.equal(transport._state.released, 1, 'der Transport-Refcount wurde nicht freigegeben');
});

checkAsync('test(): auch ein unbekannter Kontext gibt den Transport wieder frei', async () => {
  const clusters = makeClustersStub(goodKubeconfig(CLOSED_PORT_URL));
  clusters._cluster.contextName = 'gibtsnicht';
  const transport = makeTransportStub();
  const svc = new KubeClientService(clusters, transport, makeAuditStub());

  const result = await svc.test('cluster-1', 'user-1');
  assert.equal(result.ok, false);
  assert.equal(transport._state.released, 1, 'Transport-Refcount hängt — der Tunnel bleibt bis zum Neustart offen');
  assert.ok(!String(result.error).includes(`${CANARY}-token`), 'Token aus der Kubeconfig in der Fehlermeldung');
});

// ---------------------------------------------------------------------------
// I4 — die Ursache muss durchkommen
// ---------------------------------------------------------------------------

check('errorMessageWithCause hängt die Ursachenkette an', () => {
  const cause = new Error('connect ECONNREFUSED 10.0.0.1:6443');
  const err = new TypeError('fetch failed');
  err.cause = cause;
  assert.equal(errorMessageWithCause(err), 'fetch failed — connect ECONNREFUSED 10.0.0.1:6443');
});

check('errorMessageWithCause läuft zwei Ebenen tief und wiederholt sich nicht', () => {
  const inner = new Error('DEPTH_ZERO_SELF_SIGNED_CERT');
  const mid = new Error('unable to verify the first certificate');
  mid.cause = inner;
  const outer = new TypeError('fetch failed');
  outer.cause = mid;
  assert.equal(
    errorMessageWithCause(outer),
    'fetch failed — unable to verify the first certificate — DEPTH_ZERO_SELF_SIGNED_CERT',
  );

  const looping = new Error('a');
  looping.cause = looping;
  assert.equal(errorMessageWithCause(looping), 'a', 'ein Selbstbezug darf sich nicht wiederholen');
});

check('errorMessageWithCause verhält sich ohne cause wie errorMessage', () => {
  assert.equal(errorMessageWithCause(new Error('schlicht')), 'schlicht');
  assert.equal(errorMessageWithCause('ein String'), 'ein String');
  assert.equal(errorMessageWithCause(undefined), 'Unbekannter Fehler');
  const noisy = new Error('aussen');
  noisy.cause = { kein: 'message-feld' };
  assert.equal(errorMessageWithCause(noisy), 'aussen', 'eine ursachenlose Ursache darf nichts anhängen');
});

checkAsync('test(): der Verbindungsfehler nennt die Ursache statt nur "fetch failed"', async () => {
  // undici packt alles Brauchbare (ECONNREFUSED, ENOTFOUND, unable to verify
  // the first certificate) in err.cause; errorMessage() las nur .message und
  // lieferte den nutzlosen String "fetch failed" — der dann auch noch
  // persistiert und im UI angezeigt wurde. Diagnose ist der ganze Zweck
  // dieses Endpunkts. Echter Verbindungsversuch gegen einen geschlossenen
  // Port, kein Mock.
  const clusters = makeClustersStub(goodKubeconfig(CLOSED_PORT_URL));
  const transport = makeTransportStub(CLOSED_PORT_URL);
  const audit = makeAuditStub();
  const svc = new KubeClientService(clusters, transport, audit);

  const result = await svc.test('cluster-1', 'user-1');
  assert.equal(result.ok, false);
  assert.match(
    String(result.error), /ECONNREFUSED/,
    `die Ursache fehlt, der Aufrufer sieht nur: ${result.error}`,
  );
  assert.match(String(clusters._calls.connectError[0].message), /ECONNREFUSED/, 'lastConnectError ohne Ursache persistiert');
  assert.ok(String(result.error).length <= 500, 'Fehlermeldung nicht gekappt');
  assert.equal(transport._state.released, 1);
});

checkAsync('test(): eine überlange Fehlermeldung wird auf 500 Zeichen gekappt', async () => {
  const clusters = makeClustersStub(goodKubeconfig(CLOSED_PORT_URL));
  const transport = {
    async resolve() { throw new Error('x'.repeat(5000)); },
  };
  const svc = new KubeClientService(clusters, transport, makeAuditStub());
  const result = await svc.test('cluster-1', 'user-1');
  assert.equal(result.ok, false);
  assert.equal(String(result.error).length, 500, 'Response nicht gekappt');
  assert.equal(String(clusters._calls.connectError[0].message).length, 500);
});

(async () => {
  for (const run of asyncChecks) await run();
  console.log('');
  console.log(`Kube client checks: ${total - failures}/${total} passed`);
  if (failures > 0) process.exit(1);
})();
