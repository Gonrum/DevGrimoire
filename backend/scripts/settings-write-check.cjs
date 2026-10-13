#!/usr/bin/env node
/*
 * Settings-Schreibroute (Review-Fund M-6, 2026-10-13).
 *
 * `PUT /api/settings/:key` nahm jeden Key und jeden Body: ein Tippfehler legte
 * eine Zeile an, die niemand liest, `{value: {...}}` landete als Objekt in der
 * Datenbank, und die verschlüsselten Replikations-Keys liessen sich an ihrem
 * validierenden Endpoint vorbei überschreiben. Jetzt Allowlist + DTO.
 *
 * Der wichtigste Fall ist der dritte: jeder Key, den das Frontend über diese
 * Route schreibt, muss auf der Allowlist stehen — sonst bricht die UI mit 400.
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { SettingsController, GENERIC_WRITABLE_SETTING_KEYS } = loadCompiled('settings/settings.controller.js');
const { ValidationPipe } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/common'));

const EXPECTED_CHECKS = 4;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const store = new Map();
const ctrl = new SettingsController({ set: async (key, value) => { store.set(key, value); return { key, value }; } });

(async () => {
  await check('erlaubter Key wird geschrieben', async () => {
    const res = await ctrl.set('web_search_max_results', { value: '7' });
    assert.deepEqual(res, { key: 'web_search_max_results', value: '7' });
  });

  await check('unbekannter Key (Tippfehler) und Replikations-Key -> 400, nichts geschrieben', async () => {
    store.clear();
    for (const key of ['web_serch_max_results', 'replication.peer.apiKey', 'ssh.maxUploadBytes']) {
      await assert.rejects(() => ctrl.set(key, { value: 'x' }), (e) => e.getStatus?.() === 400);
    }
    assert.equal(store.size, 0);
  });

  await check('jeder Key, den das Frontend über api.settings.set schreibt, steht auf der Allowlist', () => {
    const root = path.resolve(__dirname, '..', '..', 'frontend', 'src');
    const found = new Set();
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) {
          const src = fs.readFileSync(p, 'utf8');
          for (const m of src.matchAll(/api\.settings\.set\(\s*'([^']+)'/g)) found.add(m[1]);
          // WebSearchSettings schreibt über eine Tabelle [feld, key].
          if (src.includes('api.settings.set(key')) {
            for (const m of src.matchAll(/\[\s*'[A-Za-z]+'\s*,\s*'([a-z_]+)'\s*\]/g)) found.add(m[1]);
          }
        }
      }
    };
    walk(root);
    assert.ok(found.size >= 10, `zu wenige Keys gefunden (${found.size}) — Parser kaputt?`);
    const missing = [...found].filter((k) => !GENERIC_WRITABLE_SETTING_KEYS.has(k));
    assert.deepEqual(missing, []);
  });

  await check('Body: value muss ein String sein', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const metatype = Reflect.getMetadata('design:paramtypes', SettingsController.prototype, 'set')[1];
    for (const bad of [{ value: { $gt: '' } }, { value: 42 }, {}]) {
      await assert.rejects(() => pipe.transform(bad, { type: 'body', metatype }), (e) => e.getStatus?.() === 400);
    }
    const ok = await pipe.transform({ value: 'x' }, { type: 'body', metatype });
    assert.equal(ok.value, 'x');
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
