#!/usr/bin/env node
/*
 * Persönliche Benachrichtigungs-Einstellungen (2026-10-15).
 *
 * Push-Kategorien und Ruhezeiten lagen nur instanzweit in den Settings und
 * waren nur für Admins schreibbar; die Einstellungsseite verschluckte den 403.
 * Jetzt am Nutzer, die instanzweiten Keys sind der Default. Der Push-Versand
 * filtert pro Abo-Besitzer.
 *
 * Lädt aus dist/; vorher `npm run build`.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
require(path.resolve(__dirname, '..', 'node_modules', 'reflect-metadata'));
const { Types } = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));
const { plainToInstance } = require(path.resolve(__dirname, '..', 'node_modules', 'class-transformer'));
const { validate } = require(path.resolve(__dirname, '..', 'node_modules', 'class-validator'));

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { effectivePrefs, isQuiet, allowsPush } = loadCompiled('notifications/notification-prefs.js');
const { NotificationsService } = loadCompiled('notifications/notifications.service.js');
const { NotificationsController } = loadCompiled('notifications/notifications.controller.js');
const { PushService } = loadCompiled('push/push.service.js');
const { RequestContext } = loadCompiled('common/request-context.js');

const EXPECTED_CHECKS = 8;
let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const at = (h, m = 0) => { const d = new Date(2026, 9, 15, h, m); return d; };
const DEFAULTS = {
  pushCategories: ['notify_user', 'workflow_failure'],
  quietHours: { enabled: true, from: '22:00', to: '07:00', overrides: ['workflow_failure'] },
};
const q = (val) => ({ lean: () => q(val), exec: async () => val });

(async () => {
  await check('effectivePrefs: ohne eigene Einstellung der Default, teilweise je Abschnitt', async () => {
    assert.deepEqual(effectivePrefs(undefined, DEFAULTS), DEFAULTS);
    assert.deepEqual(effectivePrefs('kaputt', DEFAULTS), DEFAULTS);
    const onlyCats = effectivePrefs({ pushCategories: ['mcp_todo'] }, DEFAULTS);
    assert.deepEqual(onlyCats.pushCategories, ['mcp_todo']);
    assert.deepEqual(onlyCats.quietHours, DEFAULTS.quietHours);
    // Leere Liste ist eine bewusste Wahl ("nichts pushen"), kein fehlender Wert.
    assert.deepEqual(effectivePrefs({ pushCategories: [] }, DEFAULTS).pushCategories, []);
  });

  await check('Ruhezeit: Fenster über Mitternacht, Ausnahme-Kategorie, unlesbare Zeit unterdrückt nichts', async () => {
    const qh = DEFAULTS.quietHours;
    assert.equal(isQuiet(qh, 'notify_user', at(23)), true);
    assert.equal(isQuiet(qh, 'notify_user', at(6, 59)), true);
    assert.equal(isQuiet(qh, 'notify_user', at(7)), false);
    assert.equal(isQuiet(qh, 'workflow_failure', at(23)), false);
    assert.equal(isQuiet(qh, undefined, at(23)), true);
    assert.equal(isQuiet({ ...qh, from: '25:00' }, 'notify_user', at(23)), false);
    assert.equal(isQuiet({ ...qh, enabled: false }, 'notify_user', at(23)), false);
  });

  await check('allowsPush: Kategorie muss gewählt sein, ohne Kategorie zählt nur die Ruhezeit', async () => {
    assert.equal(allowsPush(DEFAULTS, 'notify_user', at(12)), true);
    assert.equal(allowsPush(DEFAULTS, 'mcp_todo', at(12)), false);
    assert.equal(allowsPush(DEFAULTS, undefined, at(12)), true);
    assert.equal(allowsPush(DEFAULTS, undefined, at(23)), false);
  });

  // ---- Push-Empfänger nach Besitzer-Einstellung ------------------------------
  const OWN = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const quietUser = { _id: new Types.ObjectId(), active: true, role: 'user', notificationPrefs: { pushCategories: [] } };
  const loudUser = { _id: new Types.ObjectId(), active: true, role: 'user', projectScopeMode: 'allowlist', allowedProjectIds: [new Types.ObjectId(OWN)] };
  const subs = [
    { endpoint: 'q', userId: quietUser._id.toString() },
    { endpoint: 'l', userId: loudUser._id.toString() },
    { endpoint: 'legacy', userId: null },
  ];
  const push = new PushService(
    { find: () => q(subs) },
    { find: (f) => q([quietUser, loudUser].filter((u) => f._id.$in.includes(u._id.toString()))) },
  );

  await check('Push-Empfänger: jeder Besitzer nach seiner Einstellung, besitzerlos nach dem Default', async () => {
    const seen = [];
    const allow = (stored) => { seen.push(stored); return allowsPush(effectivePrefs(stored, DEFAULTS), 'notify_user', at(12)); };
    const ep = (await push.recipients({}, allow)).map((s) => s.endpoint).sort();
    assert.deepEqual(ep, ['l', 'legacy']);
    assert.ok(seen.includes(undefined), 'besitzerloses Abo bekommt keinen Nutzer-Wert');
  });

  await check('Push-Empfänger: Projekt-Scope bleibt zusätzlich zur Einstellung', async () => {
    const ep = (await push.recipients({ projectId: 'bbbbbbbbbbbbbbbbbbbbbbbb' }, () => true)).map((s) => s.endpoint);
    assert.deepEqual(ep, ['q'], 'nur der Nutzer mit Scope "all" sieht das fremde Projekt');
    const own = (await push.recipients({ projectId: OWN }, () => true)).map((s) => s.endpoint).sort();
    assert.deepEqual(own, ['l', 'q']);
  });

  // ---- Service: Lesen und Speichern ------------------------------------------
  function makeService(users) {
    const settingsWrites = [];
    const settings = {
      get: async () => null,
      getOrDefault: async (_k, d) => d,
      set: async (k, v) => { settingsWrites.push([k, v]); return { key: k, value: v }; },
    };
    const pushed = [];
    const pushStub = { sendNotification: async (...args) => { pushed.push(args); return { sent: 0, failed: 0 }; } };
    const userModel = {
      findById: (id) => q(users.find((u) => u._id.toString() === String(id)) ?? null),
      updateOne: (f, u) => q((() => {
        const doc = users.find((x) => x._id.toString() === f._id.toString());
        if (doc) Object.assign(doc, u.$set);
        return { matchedCount: doc ? 1 : 0 };
      })()),
    };
    const notifModel = { create: async (d) => ({ _id: new Types.ObjectId(), ...d }) };
    const svc = new NotificationsService(notifModel, { emit() {} }, pushStub, settings, userModel);
    return { svc, settingsWrites, pushed };
  }
  const PREFS = { pushCategories: ['ask_user'], quietHours: { enabled: true, from: '20:00', to: '06:30', overrides: [] } };

  await check('Nicht-Admin speichert die eigene Einstellung am Nutzer, nicht instanzweit', async () => {
    const u = { _id: new Types.ObjectId() };
    const { svc, settingsWrites } = makeService([u]);
    const actor = { userId: u._id.toString(), username: 'u', role: 'user' };
    const before = await RequestContext.run(actor, undefined, () => svc.getPreferences());
    assert.equal(before.custom, false);
    const res = await RequestContext.run(actor, undefined, () => svc.setPreferences(PREFS));
    assert.deepEqual(u.notificationPrefs, PREFS);
    assert.equal(res.custom, true);
    assert.deepEqual(res.pushCategories, ['ask_user']);
    assert.deepEqual(settingsWrites, [], 'instanzweite Settings dürfen sich nicht ändern');
    // Ohne Nutzer-Datensatz (Auth aus: Actor "system") -> instanzweit wie vorher.
    const sys = makeService([]);
    await RequestContext.run({ userId: 'system', username: 'system', role: 'admin' }, undefined, () => sys.svc.setPreferences(PREFS));
    assert.ok(sys.settingsWrites.some(([k, v]) => k === 'notification_push_categories' && v === 'ask_user'));
  });

  await check('create: Push-Filter wertet die Einstellung des Besitzers aus', async () => {
    const { svc, pushed } = makeService([]);
    await svc.create('t', 'b', '/x', 'mcp_todo', {});
    const allow = pushed[0][4];
    assert.equal(typeof allow, 'function');
    assert.equal(allow(undefined), false, 'mcp_todo ist im Default aus');
    assert.equal(allow({ pushCategories: ['mcp_todo'] }), true, 'eigene Einstellung schaltet sie ein');
  });

  await check('Route: ohne Rollen-Gate, Body validiert (Zeit, Kategorie-Form, keine Operatoren)', async () => {
    const proto = NotificationsController.prototype;
    for (const m of ['getPreferences', 'setPreferences']) {
      assert.equal(Reflect.getMetadata('roles', proto[m]), undefined, `${m} darf nicht admin-gegated sein`);
    }
    const Dto = Reflect.getMetadata('design:paramtypes', proto, 'setPreferences')[0];
    const errs = async (body) => (await validate(plainToInstance(Dto, body), { whitelist: true, forbidNonWhitelisted: true })).length;
    assert.equal(await errs(PREFS), 0);
    assert.ok(await errs({ ...PREFS, quietHours: { ...PREFS.quietHours, from: '25:00' } }) > 0);
    assert.ok(await errs({ ...PREFS, pushCategories: [{ $ne: 1 }] }) > 0);
    assert.ok(await errs({ ...PREFS, pushCategories: ['Bad Key'] }) > 0);
    assert.ok(await errs({ pushCategories: [] }) > 0, 'quietHours fehlt');
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
