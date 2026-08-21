#!/usr/bin/env node
/*
 * Check für die Cluster-Scope-Prüfung (K3, Task 1).
 *
 * Diese Prüfung erfindet nichts: sie wendet actorCanAccessProject /
 * actorCanAccessCustomer aus common/permissions.ts auf Cluster an, die
 * entweder Projekt- ODER Kunden-Scope tragen. Der Default projectScopeMode
 * 'all' bleibt erlaubend — geschlossen wird der Fall eines eingeschränkten
 * Actors, den das Kube-Modul heute ignoriert.
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

const { assertClusterAccess, canAccessCluster } = loadCompiled('kube/kube-access.guard.js');
const { Types } = require('mongoose');

const EXPECTED_CHECKS = 11;
let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const PROJECT = '69c12580c01a0739c142f1c0';
const OTHER = '000000000000000000000000';
const CUSTOMER = '69c0fee89970b0733871b663';

const projectCluster = { projectId: PROJECT, label: 'Prod' };
const customerCluster = { customerId: CUSTOMER, label: 'Kunde' };

check('unbeschränkter Actor darf (Default projectScopeMode "all")', () => {
  assert.equal(canAccessCluster(projectCluster, { projectScopeMode: 'all' }), true);
  assert.equal(canAccessCluster(projectCluster, {}), true, 'fehlender Modus muss wie "all" wirken');
});

check('eingeschränkter Actor mit passendem Projekt darf', () => {
  assert.equal(canAccessCluster(projectCluster,
    { projectScopeMode: 'restricted', allowedProjectIds: [PROJECT] }), true);
});

check('eingeschränkter Actor mit fremdem Projekt darf NICHT', () => {
  assert.equal(canAccessCluster(projectCluster,
    { projectScopeMode: 'restricted', allowedProjectIds: [OTHER] }), false);
});

check('projectScopeMode "none" sperrt auch bei passender Liste', () => {
  assert.equal(canAccessCluster(projectCluster,
    { projectScopeMode: 'none', allowedProjectIds: [PROJECT] }), false);
});

check('kunden-gebundener Cluster wird über den Kunden-Helfer geprüft', () => {
  assert.equal(canAccessCluster(customerCluster,
    { customerScopeMode: 'restricted', allowedCustomerIds: [CUSTOMER] }), true);
  assert.equal(canAccessCluster(customerCluster,
    { customerScopeMode: 'restricted', allowedCustomerIds: [] }), false);
});

check('ein Projekt-Actor darf einen Kunden-Cluster nicht per Projektregel öffnen', () => {
  // Der Cluster trägt KEINE projectId; eine Projektregel darf hier nicht greifen.
  assert.equal(canAccessCluster(customerCluster,
    { projectScopeMode: 'all', customerScopeMode: 'restricted', allowedCustomerIds: [] }), false);
});

check('fehlender Actor darf nie', () => {
  assert.equal(canAccessCluster(projectCluster, undefined), false);
});

check('assertClusterAccess wirft ForbiddenException (403) statt zu booleanen', () => {
  const err = (() => { try { assertClusterAccess(projectCluster,
    { projectScopeMode: 'restricted', allowedProjectIds: [OTHER] }); return null; }
    catch (e) { return e; } })();
  assert.ok(err, 'hätte werfen müssen');
  assert.equal(err.status, 403);
  assert.ok(!String(err.message).includes(PROJECT),
    'die Fehlermeldung darf keine fremde Projekt-Id preisgeben');
});

check('assertClusterAccess lässt einen berechtigten Actor durch', () => {
  assertClusterAccess(projectCluster, { projectScopeMode: 'all' });
});

check('ein ObjektId-förmiger Scope wird wie eine Id behandelt', () => {
  const oid = new Types.ObjectId('69c12580c01a0739c142f1c0');
  assert.equal(
    canAccessCluster({ projectId: oid, label: 'Prod' }, { projectScopeMode: 'all' }),
    true,
    'ein echtes Cluster-Dokument trägt eine ObjectId, keinen String',
  );
  assert.equal(
    canAccessCluster({ projectId: oid, label: 'Prod' },
      { projectScopeMode: 'restricted', allowedProjectIds: ['69c12580c01a0739c142f1c0'] }),
    true,
    'der Vergleich muss auf der Hex-Darstellung stattfinden',
  );
});

check('ein Cluster ohne jeden Scope wird gesperrt', () => {
  assert.equal(
    canAccessCluster({ label: 'Verwaist' }, { projectScopeMode: 'all', customerScopeMode: 'all' }),
    false,
  );
  assert.throws(() => assertClusterAccess({ label: 'Verwaist' }, { projectScopeMode: 'all' }),
    (err) => err.status === 403);
});

if (total !== EXPECTED_CHECKS) {
  console.error(`\n✗ Check count mismatch: expected ${EXPECTED_CHECKS}, got ${total}`);
  process.exit(1);
}

console.log('');
console.log(`Kube access checks: ${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
