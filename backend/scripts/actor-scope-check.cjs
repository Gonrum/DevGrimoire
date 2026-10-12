#!/usr/bin/env node
/*
 * Actor-Scope-Check (Review-Fund C-4 / C-6, 2026-10-12).
 *
 * Der Befund: `main.ts` baute den MCP-Actor mit drei Feldern
 * (`userId`, `username`, `role`) unter dem Kommentar „Mirror JwtAuthGuard
 * pattern" — gespiegelt war aber nur die Hälfte. `actorCanAccessProject()`
 * macht `actor.projectScopeMode ?? 'all'`, ein Actor ohne das Feld ist also
 * UNEINGESCHRÄNKT. Ein API-Key, der bewusst auf 'allowlist' oder 'none'
 * verengt wurde, war über /mcp, /sse und /messages vollständig offen,
 * inklusive secret_get mit Klartextwerten.
 *
 * Beide Pfade rufen jetzt dieselbe Funktion (common/actor-scope.ts). Dieser
 * Check belegt die Verengungs-Semantik und — als Regression — dass der
 * gebaute Actor die Felder WIRKLICH trägt und downstream greift.
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

const {
  actorFromApiKey, actorFromUser, scopeFromUser,
  narrowScope, intersectIds, idsToStrings,
} = loadCompiled('common/actor-scope.js');
const { actorCanAccessProject, actorCanAccessCustomer } = loadCompiled('common/permissions.js');

const EXPECTED_CHECKS = 10;

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

/** ObjectId-Attrappe: nur toString() wird gebraucht. */
const oid = (hex) => ({ toString: () => hex });

const PROJECT_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const PROJECT_C = 'cccccccccccccccccccccccc';

// ── narrowScope: ein Key kann nur verengen, nie erweitern ─────────────────

check('narrowScope: beide all -> all', () => {
  assert.deepEqual(narrowScope('all', [], 'all', []), { mode: 'all', ids: [] });
});

check('narrowScope: none gewinnt auf BEIDEN Seiten immer', () => {
  assert.deepEqual(narrowScope('none', [], 'all', [PROJECT_A]), { mode: 'none', ids: [] });
  assert.deepEqual(narrowScope('all', [PROJECT_A], 'none', []), { mode: 'none', ids: [] });
  assert.deepEqual(narrowScope('none', [], 'none', []), { mode: 'none', ids: [] });
  // Auch gegen eine Allowlist: 'none' ist absolut.
  assert.deepEqual(narrowScope('none', [PROJECT_A], 'allowlist', [PROJECT_A]), { mode: 'none', ids: [] });
});

check('narrowScope: undefined fällt auf all zurück (Altbestand ohne Scope-Felder)', () => {
  assert.deepEqual(narrowScope(undefined, [], undefined, []), { mode: 'all', ids: [] });
  assert.deepEqual(narrowScope(undefined, [], 'allowlist', [PROJECT_A]), { mode: 'allowlist', ids: [PROJECT_A] });
});

check('narrowScope: all + allowlist -> die Allowlist der ANDEREN Seite', () => {
  // Der Kern von T-210: der Key erweitert den Besitzer nicht.
  assert.deepEqual(narrowScope('all', [], 'allowlist', [PROJECT_A, PROJECT_B]),
    { mode: 'allowlist', ids: [PROJECT_A, PROJECT_B] });
  assert.deepEqual(narrowScope('allowlist', [PROJECT_B, PROJECT_C], 'all', []),
    { mode: 'allowlist', ids: [PROJECT_B, PROJECT_C] });
});

check('narrowScope: allowlist + allowlist -> Schnittmenge', () => {
  assert.deepEqual(
    narrowScope('allowlist', [PROJECT_A, PROJECT_B], 'allowlist', [PROJECT_B, PROJECT_C]),
    { mode: 'allowlist', ids: [PROJECT_B] },
  );
  // Disjunkt -> leer, also kein Zugriff (nicht etwa 'all').
  assert.deepEqual(
    narrowScope('allowlist', [PROJECT_A], 'allowlist', [PROJECT_B]),
    { mode: 'allowlist', ids: [] },
  );
});

check('intersectIds und idsToStrings', () => {
  assert.deepEqual(intersectIds(['a', 'b'], ['b', 'c']), ['b']);
  assert.deepEqual(intersectIds([], ['b']), []);
  assert.deepEqual(idsToStrings(undefined), []);
  assert.deepEqual(idsToStrings([oid(PROJECT_A), oid(PROJECT_B)]), [PROJECT_A, PROJECT_B]);
});

// ── actorFromApiKey: der C-4-Regressionstest ──────────────────────────────

check('actorFromApiKey trägt ALLE Scope-Felder — der C-4-Regressionstest', () => {
  const actor = actorFromApiKey(
    {
      _id: oid('111111111111111111111111'),
      userId: oid('222222222222222222222222'),
      projectScopeMode: 'allowlist',
      allowedProjectIds: [oid(PROJECT_A)],
      customerScopeMode: 'allowlist',
      allowedCustomerIds: [],
      permissions: ['project:read'],
    },
    { username: 'agent', role: 'user', projectScopeMode: 'all', permissions: ['project:read', 'project:write'] },
  );

  // Vor dem Fix standen genau diese vier Zeilen nicht im MCP-Actor. Ohne sie
  // macht `?? 'all'` aus einem verengten Key einen Vollzugriff.
  for (const field of ['userId', 'username', 'role', 'apiKeyId', 'permissions',
    'projectScopeMode', 'allowedProjectIds', 'customerScopeMode', 'allowedCustomerIds']) {
    assert.ok(field in actor, `das Feld "${field}" fehlt im Actor`);
    assert.notEqual(actor[field], undefined, `das Feld "${field}" ist undefined`);
  }
  assert.equal(actor.projectScopeMode, 'allowlist');
  assert.deepEqual(actor.allowedProjectIds, [PROJECT_A]);
  assert.equal(actor.apiKeyId, '111111111111111111111111');

  // Und der Endeffekt über den echten Helper — das ist die eigentliche Lücke:
  assert.equal(actorCanAccessProject(actor, PROJECT_A), true, 'eigenes Projekt muss erreichbar bleiben');
  assert.equal(actorCanAccessProject(actor, PROJECT_B), false,
    'fremdes Projekt war über MCP erreichbar (C-4)');
});

check('actorFromApiKey: ein all-Key eines verengten Besitzers bleibt verengt', () => {
  const actor = actorFromApiKey(
    { _id: oid('1'.repeat(24)), userId: oid('2'.repeat(24)), projectScopeMode: 'all', allowedProjectIds: [] },
    { username: 'u', role: 'user', projectScopeMode: 'allowlist', allowedProjectIds: [oid(PROJECT_A)] },
  );
  assert.equal(actor.projectScopeMode, 'allowlist');
  assert.equal(actorCanAccessProject(actor, PROJECT_A), true);
  assert.equal(actorCanAccessProject(actor, PROJECT_B), false);
});

check('actorFromApiKey: Permissions sind Schnittmenge, leerer Key fällt auf den Besitzer zurück', () => {
  const owner = { username: 'u', role: 'user', permissions: ['project:read', 'project:write'] };
  const withKeyPerms = actorFromApiKey(
    { _id: oid('1'.repeat(24)), userId: oid('2'.repeat(24)), permissions: ['project:read', 'admin:audit:read'] },
    owner,
  );
  assert.deepEqual(withKeyPerms.permissions, ['project:read'],
    'der Key durfte eine Permission hinzufügen, die der Besitzer nicht hat');

  const legacyKey = actorFromApiKey(
    { _id: oid('1'.repeat(24)), userId: oid('2'.repeat(24)), permissions: [] },
    owner,
  );
  assert.deepEqual(legacyKey.permissions, ['project:read', 'project:write'],
    'ein Key ohne permissions (Altbestand) sollte auf die des Besitzers zurückfallen');
});

check('actorFromUser und scopeFromUser: Altbestand ohne Scope-Felder bleibt offen', () => {
  // Dokumente von vor T-221 haben die Felder nicht; für die darf sich am
  // Zugriff nichts ändern, sonst bricht die Migration bestehende Konten.
  const legacy = actorFromUser({ _id: oid('3'.repeat(24)), username: 'old', role: 'user' });
  assert.equal(legacy.projectScopeMode, 'all');
  assert.equal(legacy.customerScopeMode, 'all');
  assert.deepEqual(legacy.allowedProjectIds, []);
  assert.deepEqual(legacy.permissions, []);
  assert.equal(legacy.userId, '3'.repeat(24));
  assert.equal(actorCanAccessProject(legacy, PROJECT_B), true);

  const scoped = actorFromUser({
    _id: oid('4'.repeat(24)), username: 'scoped', role: 'user',
    projectScopeMode: 'allowlist', allowedProjectIds: [oid(PROJECT_A)],
    customerScopeMode: 'none', permissions: ['project:read'],
  });
  assert.equal(scoped.projectScopeMode, 'allowlist');
  assert.equal(scoped.customerScopeMode, 'none');
  assert.equal(actorCanAccessProject(scoped, PROJECT_A), true);
  assert.equal(actorCanAccessProject(scoped, PROJECT_B), false);
  assert.equal(actorCanAccessCustomer(scoped, 'any'), false, "'none' muss jeden Kunden sperren");

  assert.deepEqual(scopeFromUser({}), {
    permissions: [],
    projectScopeMode: 'all',
    allowedProjectIds: [],
    customerScopeMode: 'all',
    allowedCustomerIds: [],
  });
});

console.log('');
if (total !== EXPECTED_CHECKS) {
  console.error(
    `FEHLER: erwartet ${EXPECTED_CHECKS} Fälle, tatsächlich ${total} gelaufen — der Lauf wurde offenbar vorzeitig abgebrochen.`,
  );
  process.exit(1);
}
console.log(`Actor scope checks: ${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
