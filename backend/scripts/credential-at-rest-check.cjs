#!/usr/bin/env node
/*
 * Credential-at-rest-Check (Review-Funde H-8, H-37 und der Rest von C-7,
 * 2026-10-12).
 *
 * H-8:  Refresh-Tokens lagen roh in `refreshtokens.token` — jeder DB-Lesezugriff
 *       lieferte 7 Tage gültige Sessions aller Nutzer.
 * H-37: Das Backup dumpte jede Collection, inklusive dieser Tokens und der
 *       Klartext-Replikations-API-Keys in `settings`; das Manifest behauptete
 *       `plaintextSecrets: false`.
 * C-7:  Die Replikations-Keys liegen jetzt verschlüsselt (Gate war schon da).
 *
 * Lädt aus dist/; vorher `npm run build`.
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

process.env.SECRETS_ENCRYPTION_KEY = 'ab'.repeat(32);
const { SettingsService } = loadCompiled('settings/settings.service.js');
const { SettingsController } = loadCompiled('settings/settings.controller.js');
const { EncryptionService } = loadCompiled('common/encryption.service.js');
const { AuthService, hashRefreshToken } = loadCompiled('auth/auth.service.js');
const { BackupsService } = loadCompiled('backups/backups.service.js');
const { RequestContext } = loadCompiled('common/request-context.js');

const EXPECTED_CHECKS = 8;
const PEER_KEY = 'replication.peer.apiKey';
const ENCRYPTED = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]*$/;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

function settingsModel(initial = {}) {
  const store = new Map(Object.entries(initial));
  const exec = (v) => ({ exec: async () => v });
  return {
    _store: store,
    findOne: ({ key }) => exec(store.has(key) ? { key, value: store.get(key) } : null),
    findOneAndUpdate: ({ key }, { value }) => { store.set(key, value); return exec({ key, value }); },
    updateOne: ({ key }, { value }) => { store.set(key, value); return exec({}); },
    create: async ({ key, value }) => { store.set(key, value); return { key, value }; },
  };
}

(async () => {
  const enc = new EncryptionService();

  await check('Settings: Replikations-Key wird verschlüsselt gespeichert und entschlüsselt gelesen', async () => {
    const model = settingsModel();
    const svc = new SettingsService(model, enc);
    await svc.set(PEER_KEY, 'cv_peer_secret');
    assert.match(model._store.get(PEER_KEY), ENCRYPTED);
    assert.ok(!model._store.get(PEER_KEY).includes('cv_peer_secret'));
    assert.equal(await svc.get(PEER_KEY), 'cv_peer_secret');
  });

  await check('Settings: nicht-sensitive Keys bleiben unverändert im Klartext', async () => {
    const model = settingsModel();
    const svc = new SettingsService(model, enc);
    await svc.set('replication.peer.url', 'https://peer');
    assert.equal(model._store.get('replication.peer.url'), 'https://peer');
  });

  await check('Settings: Migration verschlüsselt Altbestand, ist idempotent, Lesen bleibt gleich', async () => {
    const model = settingsModel({ [PEER_KEY]: 'cv_legacy_plain' });
    const svc = new SettingsService(model, enc);
    assert.equal(await svc.get(PEER_KEY), 'cv_legacy_plain', 'Klartext-Altbestand muss vor der Migration lesbar sein');
    await svc.onModuleInit();
    const once = model._store.get(PEER_KEY);
    assert.match(once, ENCRYPTED);
    await svc.onModuleInit();
    assert.equal(model._store.get(PEER_KEY), once, 'zweite Migration darf nicht doppelt verschlüsseln');
    assert.equal(await svc.get(PEER_KEY), 'cv_legacy_plain');
  });

  await check('Settings: nicht entschlüsselbarer Wert wird null, nicht das Chiffrat', async () => {
    const model = settingsModel({ [PEER_KEY]: `${'0'.repeat(32)}:${'0'.repeat(32)}:abcd` });
    const svc = new SettingsService(model, enc);
    assert.equal(await svc.get(PEER_KEY), null);
  });

  await check('Settings-Controller: sensitive Keys auch für Admins nur maskiert', async () => {
    const model = settingsModel();
    const svc = new SettingsService(model, enc);
    const ctrl = new SettingsController(svc);
    const admin = { userId: 'a', username: 'a', role: 'admin' };
    const put = await RequestContext.run(admin, undefined, () => ctrl.set(PEER_KEY, { value: 'cv_x' }));
    assert.equal(put.value, '***');
    const got = await RequestContext.run(admin, undefined, () => ctrl.get(PEER_KEY));
    assert.equal(got.value, '***');
  });

  await check('H-8: Refresh-Token wird nur als SHA-256 gespeichert, Klartext findet ihn', async () => {
    const rows = [];
    const auth = Object.create(AuthService.prototype);
    auth.logger = { warn() {}, log() {}, error() {} };
    auth.refreshTokenModel = {
      create: async (d) => { rows.push({ ...d, async deleteOne() {} }); },
      findOne: (f) => ({ exec: async () => rows.find((r) => r.token === f.token) ?? null }),
    };
    auth.userModel = { findById: () => ({ exec: async () => ({ _id: 'u1', username: 'u', role: 'user', active: true }) }) };
    auth.jwtService = { sign: () => 'access' };
    const token = await auth.generateRefreshToken('u1');
    assert.match(token, /^[0-9a-f]{96}$/);
    assert.equal(rows[0].token, hashRefreshToken(token));
    assert.notEqual(rows[0].token, token);
    const res = await auth.refresh(token);
    assert.equal(res.accessToken, 'access');
  });

  await check('H-8: ein aus der DB gelesener Wert ist kein einlösbares Token', async () => {
    const rows = [{ token: hashRefreshToken('x'.repeat(96)), userId: 'u1', expiresAt: new Date(Date.now() + 1e6) }];
    const auth = Object.create(AuthService.prototype);
    auth.logger = { warn() {}, log() {}, error() {} };
    auth.refreshTokenModel = { findOne: (f) => ({ exec: async () => rows.find((r) => r.token === f.token) ?? null }) };
    await assert.rejects(() => auth.refresh(rows[0].token), /Invalid or expired/);
  });

  await check('H-37: Backup lässt refreshtokens aus, Manifest benennt das Credential-Material', async () => {
    const data = { refreshtokens: [{ token: 'h' }], todos: [{ title: 't' }], 'system.views': [{}] };
    const connection = {
      db: {
        listCollections: () => ({ toArray: async () => Object.keys(data).map((name) => ({ name })) }),
        collection: (name) => ({ find: () => data[name] }),
      },
    };
    const svc = new BackupsService({}, connection, {}, {});
    let json = '';
    for await (const chunk of svc.exportDatabaseStream()) json += chunk;
    const dump = JSON.parse(json);
    assert.deepEqual(Object.keys(dump.collections), ['todos']);
    const manifest = svc.buildManifest({
      jobId: 'j', startedAt: new Date(), finishedAt: new Date(), mode: 'full_system', trigger: 'manual',
      bucket: 'b', objectPrefix: 'p', includeAttachments: false, artifacts: [],
    });
    assert.equal(manifest.includes.plaintextSecrets, undefined, 'das irreführende Feld muss weg sein');
    assert.equal(manifest.credentialMaterial.containsCredentialMaterial, true);
    assert.ok(manifest.credentialMaterial.items.some((i) => i.includes('passwordHash')));
    assert.deepEqual(manifest.excludedCollections, ['refreshtokens']);
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
