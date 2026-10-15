#!/usr/bin/env node
/*
 * Outbound-Guard (Review-Fund M-4, 2026-10-15).
 *
 * SSH-Host, Kube-Server (direct), Monitoring- und HTTP-Request-Ziele waren
 * frei wählbar: `https://169.254.169.254`, `127.0.0.1:27017` oder der
 * Compose-Dienst `mongodb` wurden vom Backend aus angesprochen. Jetzt gesperrt:
 * Loopback, unspezifiziert, Link-Local/Metadaten und die Dienste der Instanz —
 * geprüft nach der Auflösung, gegen alle Adressen, inklusive Redirect-Sprüngen.
 * Private Netze bleiben erlaubt (Kernnutzen).
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { Response, Headers } = globalThis;

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { createOutboundGuard, classifyAddress, canonicalIp, OutboundBlockedException } = loadCompiled('common/outbound-guard.js');
const { guardedFetch } = loadCompiled('common/guarded-fetch.js');
const { KubeTransportService } = loadCompiled('kube/kube-transport.service.js');
const { SshSessionService } = loadCompiled('ssh/ssh-session.service.js');

const EXPECTED_CHECKS = 12;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const DNS = {
  'mongodb': ['172.20.0.3'],
  'redis': ['172.20.0.4'],
  'k8s.corp': ['10.1.2.3'],
  'evil-loop.test': ['127.0.0.1'],
  'two-records.test': ['10.9.9.9', '169.254.169.254'],
  'to-mongo.test': ['172.20.0.3'],
  'metadata.test': ['fd00:ec2::254'],
  'public.test': ['93.184.216.34'],
  'lan-host.test': ['fe80::faf6:af44:5777:b5eb', '192.168.2.112'],
  'only-ll.test': ['fe80::1'],
};

function makeGuard(env = {}) {
  const lookups = [];
  const guard = createOutboundGuard({
    lookup: async (host) => {
      lookups.push(host);
      const hit = DNS[host];
      if (!hit) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return hit.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    interfaceAddresses: () => ['127.0.0.1', '172.20.0.9', '::1'],
    env: { MONGODB_URI: 'mongodb://u:p@mongodb:27017/db?authSource=admin', REDIS_HOST: 'redis', ...env },
    now: () => 0,
  });
  return { guard, lookups };
}

async function blocked(p, reason) {
  await assert.rejects(p, (e) => {
    assert.ok(e instanceof OutboundBlockedException, `erwartet OutboundBlockedException, bekam ${e && e.message}`);
    if (reason) assert.equal(e.reason, reason);
    assert.equal(e.getStatus(), 403);
    return true;
  });
}

(async () => {
  await check('Adressklassen: Loopback/unspezifiziert/Link-Local/Metadaten gesperrt, alle Schreibweisen', async () => {
    for (const ip of ['127.0.0.1', '127.8.9.1', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::1]']) {
      assert.equal(classifyAddress(ip), 'loopback', ip);
    }
    for (const ip of ['0.0.0.0', '::']) assert.equal(classifyAddress(ip), 'unspecified', ip);
    for (const ip of ['169.254.169.254', 'fe80::1', '::ffff:169.254.169.254']) assert.equal(classifyAddress(ip), 'link-local', ip);
    for (const ip of ['fd00:ec2::254', '100.100.100.200']) assert.equal(classifyAddress(ip), 'metadata', ip);
  });

  await check('Adressklassen: private Netze und öffentliche Adressen bleiben erlaubt', async () => {
    for (const ip of ['10.0.0.5', '192.168.1.1', '172.17.0.1', '100.64.1.1', '8.8.8.8', 'fd12::1', '2001:db8::1']) {
      assert.equal(classifyAddress(ip), null, ip);
    }
    assert.equal(canonicalIp('::ffff:a00:5'), '10.0.0.5');
  });

  await check('Name, der auf Loopback zeigt, und localhost vor DNS -> gesperrt', async () => {
    const { guard, lookups } = makeGuard();
    await blocked(guard.resolve('evil-loop.test'), 'loopback');
    await blocked(guard.resolve('localhost'), 'loopback');
    await blocked(guard.resolve('api.localhost'), 'loopback');
    assert.ok(!lookups.includes('localhost'), 'localhost darf nicht erst aufgelöst werden');
  });

  await check('Jede Adresse eines Namens zählt, nicht nur die erste', async () => {
    const { guard } = makeGuard();
    await blocked(guard.resolve('two-records.test'), 'link-local');
    await blocked(guard.resolve('metadata.test'), 'metadata');
  });

  await check('IPv6-Link-Local aus DNS (Heimrouter) wird übergangen, als Literal gesperrt', async () => {
    const { guard } = makeGuard();
    assert.deepEqual(await guard.resolve('lan-host.test'), { address: '192.168.2.112', family: 4 });
    await blocked(guard.resolve('only-ll.test'), 'link-local');
    await blocked(guard.resolve('fe80::1'), 'link-local');
  });

  await check('Dienste der Instanz: Compose-Namen, deren Adressen und eigene Interfaces -> gesperrt', async () => {
    const { guard } = makeGuard();
    await blocked(guard.resolve('mongodb'), 'instance');
    await blocked(guard.resolve('to-mongo.test'), 'instance');
    await blocked(guard.resolve('172.20.0.4'), 'instance');
    await blocked(guard.resolve('172.20.0.9'), 'instance');
  });

  await check('Erlaubtes Ziel liefert die geprüfte Adresse; DNS-Fehler geht unverändert durch', async () => {
    const { guard } = makeGuard();
    assert.deepEqual(await guard.resolve('k8s.corp'), { address: '10.1.2.3', family: 4 });
    assert.deepEqual(await guard.resolve('192.168.5.5'), { address: '192.168.5.5', family: 4 });
    await assert.rejects(guard.resolve('nope.test'), (e) => e.code === 'ENOTFOUND' && !(e instanceof OutboundBlockedException));
  });

  await check('OUTBOUND_ALLOW_HOSTS: Name und IP als Ausnahme, Rest bleibt gesperrt', async () => {
    const { guard } = makeGuard({ OUTBOUND_ALLOW_HOSTS: ' MongoDB , 127.0.0.1' });
    assert.equal((await guard.resolve('mongodb')).address, 'mongodb');
    assert.equal((await guard.resolve('evil-loop.test')).address, '127.0.0.1');
    await blocked(guard.resolve('redis'), 'instance');
    await blocked(guard.resolve('two-records.test'), 'link-local');
  });

  await check('guardedFetch: Redirect auf Metadaten wird geprüft und gestoppt', async () => {
    const { guard } = makeGuard();
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    };
    await blocked(guardedFetch('https://public.test/x', { method: 'GET' }, { followRedirects: true, guard, fetchImpl }), 'link-local');
    assert.deepEqual(calls, ['https://public.test/x']);
    // Ohne Folgen: der 302 kommt unverändert zurück, der Guard prüft nur das erste Ziel.
    const res = await guardedFetch('https://public.test/x', {}, { followRedirects: false, guard, fetchImpl });
    assert.equal(res.status, 302);
    await blocked(guardedFetch('http://127.0.0.1:27017/', {}, { followRedirects: false, guard, fetchImpl }), 'loopback');
  });

  await check('guardedFetch: 303 macht ein GET ohne Body, Origin-Wechsel lässt Authorization fallen', async () => {
    const { guard } = makeGuard();
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body, headers: new Headers(init.headers), redirect: init.redirect });
      if (calls.length === 1) return new Response(null, { status: 303, headers: { location: 'https://k8s.corp/done' } });
      return new Response('ok', { status: 200 });
    };
    const res = await guardedFetch('https://public.test/form', {
      method: 'POST', body: 'a=1', headers: { authorization: 'Bearer x', 'content-type': 'text/plain', 'x-keep': '1' },
    }, { followRedirects: true, guard, fetchImpl });
    assert.equal(res.status, 200);
    assert.equal(calls[0].redirect, 'manual');
    assert.equal(calls[1].url, 'https://k8s.corp/done');
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].body, undefined);
    assert.equal(calls[1].headers.get('authorization'), null);
    assert.equal(calls[1].headers.get('content-type'), null);
    assert.equal(calls[1].headers.get('x-keep'), '1');
  });

  await check('Kube direct: Verbindung über die geprüfte Adresse, Name bleibt TLS-servername; Loopback gesperrt', async () => {
    const { guard } = makeGuard();
    const svc = new KubeTransportService({ openTunnel: async () => { throw new Error('nicht erwartet'); } }, { outbound: guard });
    const ep = await svc.resolve({ transport: 'direct', clusterServer: 'https://k8s.corp:6443', _id: 'c1' });
    assert.equal(ep.url, 'https://10.1.2.3:6443');
    assert.equal(ep.servername, 'k8s.corp');
    await blocked(svc.resolve({ transport: 'direct', clusterServer: 'https://169.254.169.254', _id: 'c2' }), 'link-local');
    await blocked(svc.resolve({ transport: 'direct', clusterServer: 'https://evil-loop.test:6443', _id: 'c3' }), 'loopback');
  });

  await check('SSH: verbindet mit der geprüften Adresse; gesperrtes Ziel öffnet keinen Socket', async () => {
    const { guard } = makeGuard();
    const connects = [];
    const factory = {
      create: () => {
        const handlers = {};
        return {
          on: (ev, fn) => { handlers[ev] = fn; },
          connect: (cfg) => { connects.push(cfg.host); setImmediate(() => handlers.error && handlers.error(new Error('stop'))); },
          end() {}, destroy() {},
        };
      },
    };
    const sshService = { recordConnectError: async () => {}, recordConnectSuccess: async () => {} };
    const svc = new SshSessionService(sshService, {}, {}, {}, { get: async () => null }, factory);
    svc.outbound = guard;
    const conn = (host) => ({ _id: 'x', host, port: 22, username: 'u', authMethod: 'password', knownHostFingerprint: 'aa' });
    await assert.rejects(svc.openClient(conn('k8s.corp'), { password: 'p' }), /stop/);
    assert.deepEqual(connects, ['10.1.2.3']);
    await blocked(svc.openClient(conn('mongodb'), { password: 'p' }), 'instance');
    assert.deepEqual(connects, ['10.1.2.3'], 'gesperrtes Ziel hat einen Socket geöffnet');
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
