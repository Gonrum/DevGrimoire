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

  await check('ssh-tunnel öffnet genau einen Tunnel für zwei parallele Nutzer', async () => {
    let opened = 0;
    const svc = new KubeTransportService({
      openTunnel: async () => { opened += 1; return { localPort: 41234, close: () => {} }; },
    });
    const cluster = { transport: 'ssh-tunnel', clusterServer: 'https://prod:6443', _id: 'c2', sshConnectionId: 's1' };
    const a = await svc.resolve(cluster);
    const b = await svc.resolve(cluster);
    assert.equal(opened, 1, 'Tunnel wurde doppelt geöffnet');
    assert.equal(a.url, 'https://127.0.0.1:41234');
    a.release(); b.release();
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
