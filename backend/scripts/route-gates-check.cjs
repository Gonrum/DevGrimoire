#!/usr/bin/env node
/*
 * Route-Gate-Matrix (Review-Fund C-7 / C-8, 2026-10-11).
 *
 * Der wiederkehrende Befund dieses Projekts ist nicht eine falsch geschriebene
 * Zugriffskontrolle, sondern eine ROUTE, AN DIE NIE GEDACHT WURDE: in
 * replication.controller.ts waren sechs Schreib-/Aktionsrouten mit
 * `@Roles(ADMIN)` versehen und vier gleichartige direkt daneben nicht; in
 * settings.controller.ts war `PUT :key` gegated und `GET :key` nicht.
 *
 * Dieser Check macht die Erwartung explizit und scheitert, wenn eine Route
 * dazukommt, die in keiner der drei Mengen steht. Ein vergessenes Gate fällt
 * damit beim nächsten `npm run check:route-gates` auf statt im Betrieb.
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

const { SettingsController } = loadCompiled('settings/settings.controller.js');
const { ReplicationController } = loadCompiled('replication/replication.controller.js');
const { RequestContext } = loadCompiled('common/request-context.js');
const { UserRole } = loadCompiled('auth/schemas/user.schema.js');
const { ROLES_KEY } = loadCompiled('auth/decorators/roles.decorator.js');

// Nest speichert Routenpfad und HTTP-Verb als Reflect-Metadaten am Handler
// (@nestjs/common/constants: PATH_METADATA='path', METHOD_METADATA='method').
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'ALL'];

const EXPECTED_CHECKS = 12;

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
async function checkAsync(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

/** Liefert `"VERB pfad"` für jeden Handler mit Routen-Metadaten. */
function routesOf(controllerClass) {
  const out = new Map();
  const proto = controllerClass.prototype;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const handler = proto[name];
    if (typeof handler !== 'function') continue;
    const routePath = Reflect.getMetadata(PATH_METADATA, handler);
    if (routePath === undefined) continue;
    const verbIndex = Reflect.getMetadata(METHOD_METADATA, handler);
    const verb = HTTP_METHODS[verbIndex] ?? String(verbIndex);
    const roles = Reflect.getMetadata(ROLES_KEY, handler)
      ?? Reflect.getMetadata(ROLES_KEY, controllerClass);
    out.set(`${verb} ${routePath}`, { name, roles });
  }
  return out;
}

// ── Erwartete Gate-Matrix für ReplicationController ────────────────────────
//
// ADMIN_ONLY: Konfiguration und Aktionen, die ein Operator auslöst. Alle werden
// ausschließlich von ReplicationSettings.tsx aufgerufen, das Settings.tsx nur
// für Admins rendert — ein Gate bricht also keine UI.
const ADMIN_ONLY = new Set([
  'PATCH projects/:id',
  'GET remote-projects',
  'POST import-project/:id',
  'PUT config',
  'POST gc/run',
  'POST deadletter/:id/replay',
  'POST deadletter/:id/discard',
  'POST trigger-pull',
  'POST test-connection',
  'POST trigger-full-sync',
  'POST queue/clear-failed',
  'POST promote',
]);

// PEER_FACING: wird von der GEGENINSTANZ mit einem API-Key aufgerufen, nicht
// von einem Admin im Browser. Ein @Roles(ADMIN) hier würde die Replikation
// abschalten, sobald der Key-Inhaber kein Admin ist — deshalb bewusst offen.
const PEER_FACING = new Set([
  'POST receive',
  'POST full-sync',
  'GET pull',
  'POST sync/receive',
  'GET sync/pull',
  'GET status',
]);

// Bewusst (noch) nicht gegated: lesbare UI-Zustände ohne Credential- oder
// Schreibwirkung. Steht hier, damit die Menge vollständig ist und eine neue
// Route klassifiziert werden muss.
const UNGATED_UI = new Set([
  'GET projects',
  'GET config',
  'GET sync/status',
  'GET deadletter',
  'POST sync/now',
]);

(async () => {
  // ── Teil A: SettingsController.get() verhält sich korrekt ──────────────
  //
  // Der Gate sitzt hier IM Handler (key-abhängig), nicht als Metadatum — ein
  // Reflect-Check könnte ihn also nicht sehen. Deshalb verhaltensbasiert.
  const settingsStub = {
    async get(key) { return `wert-von-${key}`; },
    async set(key, value) { return { key, value }; },
  };
  const settings = new SettingsController(settingsStub);

  const SENSITIVE = 'replication.peer.apiKey';

  await checkAsync('settings: sensitiver Key ohne Actor wird verweigert (403)', async () => {
    assert.equal(RequestContext.getUser(), undefined, 'Testannahme: kein Actor');
    const err = await settings.get(SENSITIVE).then(() => null, (e) => e);
    assert.ok(err, 'GET replication.peer.apiKey ohne Actor hätte scheitern müssen');
    assert.equal(err.getStatus(), 403, `erwartet 403, bekam ${err.getStatus()}`);
  });

  await checkAsync('settings: sensitiver Key für Nicht-Admin wird verweigert (403)', async () => {
    await RequestContext.run(
      { userId: 'u1', username: 'user', role: 'user' }, undefined,
      async () => {
        const err = await settings.get(SENSITIVE).then(() => null, (e) => e);
        assert.ok(err, 'ein Nicht-Admin hätte den Peer-API-Key nicht lesen dürfen');
        assert.equal(err.getStatus(), 403);
      },
    );
  });

  await checkAsync('settings: sensitiver Key für Admin ist lesbar', async () => {
    await RequestContext.run(
      { userId: 'a1', username: 'admin', role: UserRole.ADMIN }, undefined,
      async () => {
        const res = await settings.get(SENSITIVE);
        assert.equal(res.key, SENSITIVE);
        assert.equal(res.value, `wert-von-${SENSITIVE}`);
      },
    );
  });

  await checkAsync('settings: Admin-Recht via Permission (ohne Admin-Rolle) ist lesbar', async () => {
    // actorHasPermission short-circuitet auf role==='admin' ODER auf das
    // explizite Permission-Grant — letzteres ist der Weg, um das Recht zu
    // delegieren, ohne die Rolle zu vergeben.
    await RequestContext.run({
      userId: 'o1', username: 'operator', role: 'user',
      permissions: ['admin:settings:manage'],
    }, undefined, async () => {
      const res = await settings.get(SENSITIVE);
      assert.equal(res.value, `wert-von-${SENSITIVE}`);
    });
  });

  await checkAsync('settings: Nutzer-Keys bleiben für Nicht-Admin lesbar', async () => {
    // Regressionsschutz: ein Admin-Gate auf Klassenebene würde die Tabs
    // „notifications" und „instructions" für jeden Nicht-Admin brechen —
    // beide sind in Settings.tsx NICHT admin-gegated.
    await RequestContext.run(
      { userId: 'u1', username: 'user', role: 'user' }, undefined,
      async () => {
        for (const key of [
          'notification_push_categories',
          'notification_quiet_hours_enabled',
          'notification_quiet_hours_from',
          'notification_quiet_hours_to',
          'notification_quiet_hours_overrides',
          'agent_instructions',
        ]) {
          const res = await settings.get(key);
          assert.equal(res.key, key, `${key} war für einen Nicht-Admin nicht lesbar`);
        }
      },
    );
  });

  await checkAsync('settings: Nutzer-Keys bleiben ohne Actor lesbar (Auth deaktiviert)', async () => {
    // Bei deaktivierter Auth gibt es keinen Actor. Die persönlichen
    // Einstellungen müssen trotzdem funktionieren, sonst ist die Instanz im
    // Auth-off-Modus (Docker-Default, wenn AUTH_* leer) unbenutzbar.
    const res = await settings.get('notification_quiet_hours_from');
    assert.equal(res.key, 'notification_quiet_hours_from');
  });

  await checkAsync('settings: unbekannter sensitiver Key ist fail-closed', async () => {
    // Die Allowlist entscheidet, nicht eine Denylist bekannter Secrets: ein
    // neu angelegter Key ist für Nicht-Admins unsichtbar, bis er bewusst
    // freigegeben wird.
    await RequestContext.run(
      { userId: 'u1', username: 'user', role: 'user' }, undefined,
      async () => {
        for (const key of [
          'brand_neuer_key',
          'chat_llm_endpoints_v2',
          'rag_embedding_endpoints_v1',
          'web_search_searxng_url',
          'replication.slave.apiKey',
        ]) {
          const err = await settings.get(key).then(() => null, (e) => e);
          assert.ok(err, `${key} hätte für einen Nicht-Admin gesperrt sein müssen`);
          assert.equal(err.getStatus(), 403, `${key}: erwartet 403, bekam ${err.getStatus()}`);
        }
      },
    );
  });

  await checkAsync('settings: PUT bleibt admin-gegated', async () => {
    const roles = Reflect.getMetadata(ROLES_KEY, SettingsController.prototype.set);
    assert.deepEqual(roles, [UserRole.ADMIN],
      'PUT /settings/:key hat kein @Roles(ADMIN) mehr');
  });

  // ── Teil B: ReplicationController-Gate-Matrix ──────────────────────────

  const routes = routesOf(ReplicationController);

  check('replication: alle ADMIN_ONLY-Routen tragen @Roles(ADMIN)', () => {
    for (const key of ADMIN_ONLY) {
      const route = routes.get(key);
      assert.ok(route, `Route "${key}" existiert nicht mehr — Matrix ist veraltet`);
      assert.deepEqual(route.roles, [UserRole.ADMIN],
        `"${key}" (Handler ${route.name}) ist NICHT admin-gegated`);
    }
  });

  check('replication: keine PEER_FACING-Route trägt @Roles', () => {
    for (const key of PEER_FACING) {
      const route = routes.get(key);
      assert.ok(route, `Route "${key}" existiert nicht mehr — Matrix ist veraltet`);
      assert.equal(route.roles, undefined,
        `"${key}" trägt @Roles — das würde die Replikation abschalten, ` +
        'sobald der API-Key-Inhaber kein Admin ist');
    }
  });

  await checkAsync('replication: jede Route ist in der Matrix klassifiziert', async () => {
    // Der eigentliche Regressionsschutz: eine NEUE Route, die niemand
    // einordnet, lässt diesen Fall scheitern. Genau so sind C-7/C-8
    // entstanden — nicht durch eine falsche Regel, sondern durch eine Route,
    // an die niemand gedacht hat.
    const unclassified = [];
    for (const [key, route] of routes) {
      if (ADMIN_ONLY.has(key) || PEER_FACING.has(key) || UNGATED_UI.has(key)) continue;
      unclassified.push(`${key} (Handler ${route.name})`);
    }
    assert.deepEqual(unclassified, [],
      'Diese Routen sind in keiner der drei Mengen — bitte bewusst einordnen ' +
      '(ADMIN_ONLY / PEER_FACING / UNGATED_UI) statt sie ungeprüft zu lassen');
  });

  check('replication: keine UNGATED_UI-Route trägt versehentlich @Roles', () => {
    for (const key of UNGATED_UI) {
      const route = routes.get(key);
      assert.ok(route, `Route "${key}" existiert nicht mehr — Matrix ist veraltet`);
      assert.equal(route.roles, undefined,
        `"${key}" ist als ungegated klassifiziert, trägt aber @Roles — Matrix anpassen`);
    }
  });

  console.log('');
  if (total !== EXPECTED_CHECKS) {
    console.error(
      `FEHLER: erwartet ${EXPECTED_CHECKS} Fälle, tatsächlich ${total} gelaufen — der Lauf wurde offenbar vorzeitig abgebrochen.`,
    );
    process.exit(1);
  }
  console.log(`Route gate checks: ${total - failures}/${total} passed`);
  process.exit(failures > 0 ? 1 : 0);
})();
