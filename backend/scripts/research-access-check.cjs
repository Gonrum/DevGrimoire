#!/usr/bin/env node
/*
 * Recherche-Zugriff (Webrecherche Plan 1, Task 1).
 *
 * Persönliche Recherchen sieht nur der Besitzer (Admin alle); zugeordnete
 * Recherchen folgen dem Projekt-/Kunden-Scope. Vorher prüfte /api/research
 * keinen Scope.
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

const { canReadResearch, visibleResearchFilter, assertMoveTarget, isAssigned } = loadCompiled('research/research-access.js');

const EXPECTED_CHECKS = 7;
let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const P1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const P2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const alice = { userId: '111111111111111111111111', username: 'alice', role: 'user', projectScopeMode: 'allowlist', allowedProjectIds: [P1] };
const bob = { userId: '222222222222222222222222', username: 'bob', role: 'user' };
const admin = { userId: '333333333333333333333333', username: 'root', role: 'admin' };
const mine = { ownerUserId: alice.userId };
const inP1 = { ownerUserId: bob.userId, projectId: P1 };
const inP2 = { ownerUserId: null, projectId: P2 };

check('isAssigned: projectId oder customerId', () => {
  assert.equal(isAssigned(mine), false);
  assert.equal(isAssigned(inP1), true);
  assert.equal(isAssigned({ customerId: P2 }), true);
});

check('persönlich: nur Besitzer und Admin', () => {
  assert.equal(canReadResearch(alice, mine), true);
  assert.equal(canReadResearch(bob, mine), false);
  assert.equal(canReadResearch(admin, mine), true);
});

check('zugeordnet: Projekt-Scope entscheidet, nicht der Besitzer', () => {
  assert.equal(canReadResearch(alice, inP1), true);
  assert.equal(canReadResearch(alice, inP2), false, 'allowlist ohne P2');
  assert.equal(canReadResearch(bob, inP2), true, 'Scope all');
});

check('ohne Actor erlaubt (Auth aus)', () => {
  assert.equal(canReadResearch(undefined, mine), true);
});

check('visibleResearchFilter: persönlich nur eigene, zugeordnet nach Allowlist', () => {
  const f = JSON.stringify(visibleResearchFilter(alice));
  assert.match(f, new RegExp(alice.userId));
  assert.match(f, new RegExp(P1));
  assert.ok(!f.includes(bob.userId));
});

check('visibleResearchFilter: Admin ohne Einschränkung auf persönliche', () => {
  const f = JSON.stringify(visibleResearchFilter(admin));
  assert.ok(!f.includes('ownerUserId'), f);
});

check('assertMoveTarget: genau ein Ziel, Zugriff nötig', () => {
  assert.throws(() => assertMoveTarget(alice, {}), (e) => e.getStatus() === 400);
  assert.throws(() => assertMoveTarget(alice, { projectId: P1, customerId: P2 }), (e) => e.getStatus() === 400);
  assert.throws(() => assertMoveTarget(alice, { projectId: P2 }), (e) => e.getStatus() === 403);
  assert.doesNotThrow(() => assertMoveTarget(alice, { projectId: P1 }));
});

console.log(`\n${total - failures}/${total} passed`);
if (total !== EXPECTED_CHECKS) { console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`); process.exit(1); }
process.exit(failures === 0 ? 0 : 1);
