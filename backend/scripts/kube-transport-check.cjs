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

  await check('invalidate() wirft den gecachten Tunnel weg — der nächste resolve() baut neu auf', async () => {
    // Ohne diesen Weg leert sich der Cache ausschliesslich über refs=0 plus
    // Idle-TTL. Mit K2s 2–5-s-Polling setzt aber JEDES acquire den
    // Idle-Timer zurück — ein veralteter Eintrag (andere Bastion, gelöschter
    // Cluster, toter SSH-Client) könnte beliebig lange überleben.
    let opened = 0;
    let closed = 0;
    const svc = new KubeTransportService({
      openTunnel: async () => { opened += 1; return { localPort: 41234 + opened, close: () => { closed += 1; } }; },
    }, { idleTtlMs: 60_000 });
    const cluster = { transport: 'ssh-tunnel', clusterServer: 'https://prod:6443', _id: 'inv-1', sshConnectionId: 's1' };

    const a = await svc.resolve(cluster);
    assert.equal(opened, 1);
    a.release(); // refs=0, aber Idle-TTL läuft noch: Eintrag bleibt gecacht

    svc.invalidate('inv-1');
    // Der Map-Eintrag verschwindet SYNCHRON (der nächste resolve() baut
    // sofort neu auf); das Schliessen hängt am gecachten Promise und läuft
    // deshalb einen Microtask später.
    await new Promise((r) => setImmediate(r));
    assert.equal(closed, 1, 'invalidate() hat den Tunnel nicht geschlossen');

    const b = await svc.resolve(cluster);
    assert.equal(opened, 2, 'nach invalidate() wurde der alte, tote Eintrag wiederverwendet');
    assert.equal(b.url, 'https://127.0.0.1:41236', 'der neue Tunnel wurde nicht benutzt');
    b.release();
  });

  await check('invalidate() schliesst auch einen Tunnel, den noch jemand hält (Bastion gewechselt)', async () => {
    let closed = 0;
    const svc = new KubeTransportService({
      openTunnel: async () => ({ localPort: 41234, close: () => { closed += 1; } }),
    }, { idleTtlMs: 60_000 });
    const cluster = { transport: 'ssh-tunnel', clusterServer: 'https://prod:6443', _id: 'inv-2', sshConnectionId: 's1' };
    const a = await svc.resolve(cluster);
    svc.invalidate('inv-2');
    await new Promise((r) => setImmediate(r));
    assert.equal(closed, 1, 'ein noch gehaltener Eintrag blieb trotz invalidate() stehen');
    // Das nachlaufende release() des Halters darf nichts kaputt machen.
    a.release();
    await new Promise((r) => setImmediate(r));
    assert.equal(closed, 1, 'release() nach invalidate() hat ein zweites Mal geschlossen');
  });

  await check('invalidate() auf unbekanntem Cluster ist ein No-Op', () => {
    const svc = new KubeTransportService({ openTunnel: async () => { throw new Error('nicht rufen'); } });
    svc.invalidate('gibtsnicht');
  });

  await check('ein gebrochener Tunnel (onBroken) räumt seinen eigenen Cache-Eintrag ab', async () => {
    // C1: SshSessionService meldet den ungeplanten Abbau über onBroken.
    // Der Transport MUSS daraufhin seinen Eintrag wegwerfen, sonst zeigt
    // der Cache weiter auf einen Listener vor einem toten SSH-Client.
    let opened = 0;
    let closed = 0;
    let broken = null;
    const svc = new KubeTransportService({
      openTunnel: async (_connId, _host, _port, onBroken) => {
        opened += 1;
        broken = onBroken;
        return { localPort: 41234 + opened, close: () => { closed += 1; } };
      },
    }, { idleTtlMs: 60_000 });
    const cluster = { transport: 'ssh-tunnel', clusterServer: 'https://prod:6443', _id: 'broken-1', sshConnectionId: 's1' };

    const a = await svc.resolve(cluster);
    assert.equal(typeof broken, 'function', 'openTunnel bekam keinen onBroken-Callback');
    a.release();

    broken();
    await new Promise((r) => setImmediate(r));

    const b = await svc.resolve(cluster);
    assert.equal(opened, 2, 'nach dem Bruch wurde der tote Cache-Eintrag wiederverwendet');
    b.release();
    assert.ok(closed >= 1, 'der gebrochene Tunnel wurde nicht geschlossen');
  });

  await check('direct lehnt nicht-https ab (kein Bearer-Token im Klartext)', async () => {
    // rewriteServerUrl prüfte https nur auf dem TUNNEL-Pfad; `direct` gab
    // cluster.clusterServer unverändert zurück. Ein `http://prod:8080`
    // hätte `Authorization: Bearer <token>` im Klartext auf die Leitung
    // gelegt.
    const svc = new KubeTransportService({ openTunnel: async () => { throw new Error('nicht rufen'); } });
    const err = await svc.resolve({ transport: 'direct', clusterServer: 'http://prod:8080', _id: 'plain-1' })
      .then(() => null, (e) => e);
    assert.ok(err, 'http auf dem direct-Pfad wurde akzeptiert');
    assert.equal(err.status, 400, 'muss BadRequest sein');
    assert.match(String(err.message), /https/i);
  });

  await check('direct lehnt eine leere/kaputte Server-URL als 400 ab (nicht 500)', async () => {
    const svc = new KubeTransportService({ openTunnel: async () => { throw new Error('nicht rufen'); } });
    for (const bad of ['', 'prod:6443', 'nicht mal eine url']) {
      const err = await svc.resolve({ transport: 'direct', clusterServer: bad, _id: 'bad-url' })
        .then(() => null, (e) => e);
      assert.ok(err, `"${bad}" wurde akzeptiert`);
      assert.equal(err.status, 400, `"${bad}" ergab keinen 400 (TypeError aus new URL() wird sonst zu 500)`);
    }
  });

  await check('ssh-tunnel lehnt eine kaputte Server-URL als 400 ab (nicht 500)', async () => {
    const svc = new KubeTransportService({ openTunnel: async () => { throw new Error('nicht rufen'); } });
    const err = await svc.resolve({ transport: 'ssh-tunnel', clusterServer: '', _id: 'bad-url-2', sshConnectionId: 's1' })
      .then(() => null, (e) => e);
    assert.ok(err, 'leere URL wurde akzeptiert');
    assert.equal(err.status, 400);
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
