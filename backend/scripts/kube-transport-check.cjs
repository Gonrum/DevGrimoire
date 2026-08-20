#!/usr/bin/env node
/*
 * Pure-logic check für die Transport-Auflösung (K1, Task 4).
 * Der SSH-Teil wird gestubbt — geprüft wird die URL-Umschreibung und
 * der Refcount/TTL-Lebenszyklus des Tunnel-Caches.
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

const { KubeTransportService, rewriteServerUrl } = loadCompiled('kube/kube-transport.service.js');

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  return Promise.resolve().then(fn).then(
    () => console.log(`✓ ${label}`),
    (err) => { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); },
  );
}

(async () => {
  await check('rewriteServerUrl behält den echten Host als servername', () => {
    const out = rewriteServerUrl('https://prod.example.com:6443', 41234);
    assert.equal(out.url, 'https://127.0.0.1:41234');
    assert.equal(out.servername, 'prod.example.com');
  });

  await check('rewriteServerUrl kommt mit fehlendem Port klar', () => {
    const out = rewriteServerUrl('https://prod.example.com', 41234);
    assert.equal(out.servername, 'prod.example.com');
  });

  await check('rewriteServerUrl lehnt nicht-https ab', () => {
    assert.throws(() => rewriteServerUrl('http://prod.example.com:6443', 1), /https/i);
  });

  await check('direct gibt die Server-URL unverändert zurück', async () => {
    const svc = new KubeTransportService({ openTunnel: async () => { throw new Error('darf nicht gerufen werden'); } });
    const ep = await svc.resolve({ transport: 'direct', clusterServer: 'https://prod:6443', _id: 'c1' });
    assert.equal(ep.url, 'https://prod:6443');
    assert.equal(ep.servername, 'prod');
    ep.release();
  });

  await check('ssh-tunnel öffnet genau einen Tunnel für zwei GLEICHZEITIGE Nutzer (TOCTOU)', async () => {
    // Regression für Review-Runde 1: die alte Implementierung las
    // this.tunnels.get(key) synchron, aber schrieb this.tunnels.set(key, …)
    // erst NACH einem await auf openTunnel(). Zwei Aufrufe, die im selben
    // Tick starten (nicht nacheinander awaited!), sahen beide "nichts
    // gecacht" und öffneten beide einen echten Tunnel; der zuletzt
    // schreibende gewann den Map-Slot. Der Stub verzögert per setTimeout,
    // damit die Race-Window auch einen vollen Event-Loop-Tick überlebt und
    // nicht nur eine Microtask — ein synchron auflösender Stub würde die
    // Lücke genauso gut verdecken wie der frühere sequenzielle Test.
    let opened = 0;
    let closed = 0;
    const svc = new KubeTransportService({
      openTunnel: async () => {
        opened += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { localPort: 41234, close: () => { closed += 1; } };
      },
    }, { idleTtlMs: 0 });
    const cluster = { transport: 'ssh-tunnel', clusterServer: 'https://prod:6443', _id: 'race-1', sshConnectionId: 's1' };

    // Beide Aufrufe VOR dem ersten await starten — Promise.all über zwei
    // noch nicht awaitete resolve()-Aufrufe, nicht sequenziell await/await.
    const [a, b] = await Promise.all([svc.resolve(cluster), svc.resolve(cluster)]);

    assert.equal(opened, 1, 'Tunnel wurde doppelt geöffnet (TOCTOU)');
    assert.equal(a.url, 'https://127.0.0.1:41234');
    assert.equal(b.url, 'https://127.0.0.1:41234');

    // Der eine Halter darf mit seinem release() nicht den Tunnel schließen,
    // den der andere Halter noch aktiv hält — genau der Refcount-Bug, bei
    // dem releaseTunnel() per Key statt über den konkret erhöhten Eintrag
    // schloss.
    b.release();
    await new Promise((r) => setImmediate(r));
    assert.equal(closed, 0, 'release() eines Halters hat den vom anderen Halter noch genutzten Tunnel geschlossen');

    a.release();
    await new Promise((r) => setImmediate(r));
    assert.equal(closed, 1, 'Tunnel wurde nach dem letzten release nicht geschlossen');
  });

  await check('rewriteServerUrl-Fehler nach dem Öffnen gibt den Ref sauber frei (kein Leak)', async () => {
    // Regression für Review-Runde 1: entry.refs += 1 lief vor dem Aufruf von
    // rewriteServerUrl(), der bei nicht-https clusterServer wirft. Der
    // Aufrufer bekam dann nie eine release()-Closure — der Ref konnte nie
    // wieder auf 0 fallen, der Tunnel blieb für die Lebensdauer des
    // Prozesses offen.
    let opened = 0;
    let closed = 0;
    const svc = new KubeTransportService({
      openTunnel: async () => { opened += 1; return { localPort: 41234, close: () => { closed += 1; } }; },
    }, { idleTtlMs: 0 });
    const cluster = { transport: 'ssh-tunnel', clusterServer: 'http://prod:6443', _id: 'bad-1', sshConnectionId: 's1' };

    const err = await svc.resolve(cluster).then(() => null, (e) => e);
    assert.ok(err, 'hätte an rewriteServerUrl (kein https) scheitern müssen');
    assert.match(String(err && err.message), /https/i);

    await new Promise((r) => setImmediate(r));
    assert.equal(opened, 1, 'Tunnel wurde geöffnet');
    assert.equal(closed, 1, 'Ref wurde nicht zurückgenommen — Tunnel bleibt für immer offen (Leak)');
  });

  await check('openTunnel-Ablehnung räumt den Cache-Key auf (Retry möglich)', async () => {
    // Teil desselben TOCTOU-Fixes: der Promise wird synchron gecacht, bevor
    // er überhaupt aufgelöst ist. Schlägt er fehl, darf der Key nicht für
    // immer mit einem abgelehnten Promise belegt bleiben — sonst könnte kein
    // späterer Aufruf je wieder einen Tunnel für diesen Cluster öffnen.
    let attempts = 0;
    const svc = new KubeTransportService({
      openTunnel: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('ssh_connect_failed');
        return { localPort: 41234, close: () => {} };
      },
    }, { idleTtlMs: 0 });
    const cluster = { transport: 'ssh-tunnel', clusterServer: 'https://prod:6443', _id: 'retry-1', sshConnectionId: 's1' };

    const firstErr = await svc.resolve(cluster).then(() => null, (e) => e);
    assert.ok(firstErr, 'erster Versuch hätte an openTunnel scheitern müssen');

    const ep = await svc.resolve(cluster);
    assert.equal(attempts, 2, 'zweiter Aufruf hat den alten, abgelehnten Promise wiederverwendet statt neu zu versuchen');
    assert.equal(ep.url, 'https://127.0.0.1:41234');
    ep.release();
  });

  await check('Tunnel wird erst nach dem letzten release geschlossen', async () => {
    let closed = 0;
    const svc = new KubeTransportService({
      openTunnel: async () => ({ localPort: 41234, close: () => { closed += 1; } }),
    }, { idleTtlMs: 0 });
    const cluster = { transport: 'ssh-tunnel', clusterServer: 'https://prod:6443', _id: 'c3', sshConnectionId: 's1' };
    const a = await svc.resolve(cluster);
    const b = await svc.resolve(cluster);
    a.release();
    assert.equal(closed, 0, 'zu früh geschlossen');
    b.release();
    await new Promise((r) => setImmediate(r));
    assert.equal(closed, 1, 'nach dem letzten release nicht geschlossen');
  });

  await check('doppeltes release zählt nur einmal', async () => {
    let closed = 0;
    const svc = new KubeTransportService({
      openTunnel: async () => ({ localPort: 41234, close: () => { closed += 1; } }),
    }, { idleTtlMs: 0 });
    const cluster = { transport: 'ssh-tunnel', clusterServer: 'https://prod:6443', _id: 'c4', sshConnectionId: 's1' };
    const a = await svc.resolve(cluster);
    const b = await svc.resolve(cluster);
    a.release(); a.release();
    assert.equal(closed, 0, 'doppeltes release hat den Refcount des anderen Nutzers gefressen');
    b.release();
    await new Promise((r) => setImmediate(r));
    assert.equal(closed, 1);
  });

  await check('ssh-tunnel ohne sshConnectionId wird abgelehnt', async () => {
    const svc = new KubeTransportService({ openTunnel: async () => ({ localPort: 1, close: () => {} }) });
    const err = await svc.resolve({ transport: 'ssh-tunnel', clusterServer: 'https://p:6443', _id: 'c5' })
      .then(() => null, (e) => e);
    assert.ok(err, 'hätte fehlschlagen müssen');
  });

  console.log('');
  console.log(`Kube transport checks: ${total - failures}/${total} passed`);
  if (failures > 0) process.exit(1);
})();
