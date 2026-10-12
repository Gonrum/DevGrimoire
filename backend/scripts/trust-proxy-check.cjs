#!/usr/bin/env node
/*
 * trust-proxy-Check (Review-Fund H-1, 2026-10-11).
 *
 * Zwei Ebenen:
 *  1. `resolveTrustProxy()` — reine Übersetzung des Env-Strings.
 *  2. Das ECHTE Express-Verhalten gegen einen lokalen Server. Die Parser-Tests
 *     allein würden nichts beweisen: der ganze Fund besteht darin, dass
 *     `req.ip` ohne `trust proxy` die Proxy-Adresse ist und damit drei
 *     voneinander unabhängige Mechanismen still kaputt waren (Login-Throttling,
 *     Refresh-Token-IP-Bindung, Audit-ipAddress).
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const express = require('express');
const { resolveTrustProxy } = loadCompiled('common/trust-proxy.js');

const EXPECTED_CHECKS = 10;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

/**
 * Startet einen Express-Server mit `GET /ip` -> `req.ip` und liefert einen
 * Helper, der mit beliebigen Headern dagegen anfragt.
 */
async function withServer(trustProxy, run) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/ip', (_req, res) => { res.json({ ip: _req.ip, ips: _req.ips }); });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await run(async (headers = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/ip`, { headers });
      return res.json();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

(async () => {
  // ── 1. Parser ──────────────────────────────────────────────────────────

  await check('resolveTrustProxy: unset/leer ergibt den Compose-Default (1 Hop, als ZAHL)', () => {
    // Als Zahl, nicht als String: Express/proxy-addr parst einen String als
    // IP-Adresse bzw. Subnetz und nur eine Zahl als Hop-Anzahl. `'1'` wäre ein
    // Parse-Versuch einer IP, kein "ein Hop".
    assert.equal(resolveTrustProxy(undefined), 1);
    assert.equal(typeof resolveTrustProxy(undefined), 'number');
    assert.equal(resolveTrustProxy(''), 1);
    assert.equal(resolveTrustProxy('   '), 1);
  });

  await check('resolveTrustProxy: boolsche Werte', () => {
    for (const v of ['false', 'FALSE', 'off', 'no', '0']) {
      // '0' ist eine Ganzzahl und wird zur Zahl 0 — Express behandelt 0 wie false.
      const got = resolveTrustProxy(v);
      const ok = v === '0' ? got === 0 : got === false;
      assert.ok(ok, `"${v}" -> ${JSON.stringify(got)}, erwartet false/0`);
    }
    for (const v of ['true', 'TRUE', 'on', 'yes']) {
      assert.equal(resolveTrustProxy(v), true, `"${v}" sollte true ergeben`);
    }
  });

  await check('resolveTrustProxy: Ganzzahl wird zur number, nicht zum Subnetz-String', () => {
    // Der Kern der Übersetzung: `app.set('trust proxy', '1')` würde Express als
    // SUBNETZ-Angabe lesen, `1` als Hop-Anzahl. Beides verhält sich anders.
    assert.equal(resolveTrustProxy('1'), 1);
    assert.equal(typeof resolveTrustProxy('2'), 'number');
    assert.equal(resolveTrustProxy(' 3 '), 3);
  });

  await check('resolveTrustProxy: benannte Bereiche und Subnetze bleiben Strings', () => {
    assert.equal(resolveTrustProxy('loopback'), 'loopback');
    assert.equal(resolveTrustProxy('uniquelocal'), 'uniquelocal');
    assert.equal(resolveTrustProxy('10.0.0.0/8'), '10.0.0.0/8');
  });

  await check('resolveTrustProxy: Kommaliste wird zum Array', () => {
    assert.deepEqual(resolveTrustProxy('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8']);
    assert.deepEqual(resolveTrustProxy('1,loopback'), [1, 'loopback']);
  });

  // ── 2. Echtes Express-Verhalten ────────────────────────────────────────

  await check('OHNE trust proxy ist req.ip die Proxy-Adresse — der Befund selbst', async () => {
    await withServer(false, async (get) => {
      const body = await get({ 'X-Forwarded-For': '203.0.113.9' });
      // Genau das war der Zustand vor dem Fix: der nginx setzt X-Forwarded-For
      // korrekt, Express ignoriert es, und jeder Client teilt sich dieselbe
      // Adresse. Damit war @Throttle(5/min) auf /api/auth/login ein globaler
      // Eimer und jedes ipAddress im Audit-Log dasselbe.
      assert.equal(body.ip, '127.0.0.1',
        'ohne trust proxy sollte req.ip die Socket-Adresse sein');
      assert.deepEqual(body.ips, [], 'ohne trust proxy bleibt req.ips leer');
    });
  });

  await check('MIT trust proxy=1 wird req.ip zur echten Client-Adresse', async () => {
    await withServer(resolveTrustProxy('1'), async (get) => {
      const body = await get({ 'X-Forwarded-For': '203.0.113.9' });
      assert.equal(body.ip, '203.0.113.9',
        'mit trust proxy=1 sollte req.ip die vom Proxy gemeldete Client-Adresse sein');
    });
  });

  await check('trust proxy=1: Spoofing hinter einem Proxy funktioniert NICHT', async () => {
    // Der Sicherheitsnachweis für den Default. nginx HÄNGT die echte
    // Client-Adresse an die Liste an (frontend/nginx.conf setzt
    // X-Forwarded-For $proxy_add_x_forwarded_for). Ein Client, der selbst
    // `X-Forwarded-For: gefaelscht` schickt, produziert also
    // `gefaelscht, echt` — und `1` vertraut nur dem rechten Eintrag.
    await withServer(resolveTrustProxy('1'), async (get) => {
      const body = await get({ 'X-Forwarded-For': '198.51.100.66, 203.0.113.9' });
      assert.equal(body.ip, '203.0.113.9',
        'der linke (vom Client geschmuggelte) Eintrag wurde als Client-IP übernommen');
    });
  });

  await check('DOKUMENTIERTE GRENZE: ohne Proxy ist trust proxy=1 per Header umgehbar', async () => {
    // Kein Schönheitsfehler, sondern der Grund, warum TRUST_PROXY konfigurierbar
    // ist: läuft das Backend direkt (Entwicklung, oder die Port-Bindung
    // `3200:3000` in docker-compose.yml ohne vorgelagerten nginx), dann IST der
    // Client der eine vertrauete Hop und sein Header gewinnt. In dem Fall muss
    // TRUST_PROXY=false gesetzt werden. Dieser Fall belegt die Warnung im
    // JSDoc von resolveTrustProxy.
    await withServer(resolveTrustProxy('1'), async (get) => {
      const body = await get({ 'X-Forwarded-For': '198.51.100.66' });
      assert.equal(body.ip, '198.51.100.66',
        'erwartet: ohne echten Proxy wird der Header des Clients vertraut');
    });
    await withServer(resolveTrustProxy('false'), async (get) => {
      const body = await get({ 'X-Forwarded-For': '198.51.100.66' });
      assert.equal(body.ip, '127.0.0.1',
        'mit TRUST_PROXY=false muss der Header ignoriert werden');
    });
  });

  await check('DER PRODUKTIONS-DEFAULT (TRUST_PROXY unset) verhält sich wie 1 Hop', async () => {
    // Dieser Fall lief im ersten Anlauf durchs Raster, weil die anderen
    // Server-Tests resolveTrustProxy('1') aufriefen — also den explizit
    // gesetzten Wert, nicht den Default. Der Default ist aber genau das, was
    // ein Compose-Deployment ohne .env-Eintrag bekommt.
    await withServer(resolveTrustProxy(process.env.TRUST_PROXY), async (get) => {
      const body = await get({ 'X-Forwarded-For': '203.0.113.9' });
      assert.equal(body.ip, '203.0.113.9',
        'mit dem Default sollte req.ip die vom Proxy gemeldete Client-Adresse sein');
      const spoofed = await get({ 'X-Forwarded-For': '198.51.100.66, 203.0.113.9' });
      assert.equal(spoofed.ip, '203.0.113.9',
        'der Default darf einen vom Client geschmuggelten XFF-Eintrag nicht übernehmen');
    });
  });

  console.log('');
  if (total !== EXPECTED_CHECKS) {
    console.error(
      `FEHLER: erwartet ${EXPECTED_CHECKS} Fälle, tatsächlich ${total} gelaufen — der Lauf wurde offenbar vorzeitig abgebrochen.`,
    );
    process.exit(1);
  }
  console.log(`Trust proxy checks: ${total - failures}/${total} passed`);
  process.exit(failures > 0 ? 1 : 0);
})();
