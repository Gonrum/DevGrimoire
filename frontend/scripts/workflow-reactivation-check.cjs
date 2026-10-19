#!/usr/bin/env node
/**
 * Reaktivierungs-Hinweis im Workflow-Editor (Final-Review M3).
 * Übersetzt die importfreie `src/lib/workflow-reactivation.ts` nach CommonJS
 * (Muster: research-lib-check.cjs) und prüft, wann der Hinweis erscheint.
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-workflow-reactivation-'));
try {
  execFileSync('npx', ['tsc', 'src/lib/workflow-reactivation.ts', '--outDir', outDir, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck'],
    { cwd: root, stdio: 'pipe' });
} catch (err) {
  console.error('tsc-Übersetzung fehlgeschlagen:');
  console.error(err.stdout ? err.stdout.toString() : err.message);
  process.exit(1);
}
const { needsSshReactivation } = require(path.join(outDir, 'workflow-reactivation.js'));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`✓ ${label}`); } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
  }
}

const withUser = { approvedByUserId: '64b000000000000000000a0a' };
const legacy = { approvedByUsername: 'legacy' };

check('aktiv + ssh.exec + approvals fehlt → Hinweis', () => {
  assert.equal(needsSshReactivation({ status: 'active' }, true), true);
});
check('aktiv + ssh.exec + approvals leer → Hinweis', () => {
  assert.equal(needsSshReactivation({ status: 'active', approvals: [] }, true), true);
});
check('aktiv + ssh.exec + letzte Approval ohne Nutzer → Hinweis', () => {
  assert.equal(needsSshReactivation({ status: 'active', approvals: [withUser, legacy] }, true), true);
});
check('aktiv + ssh.exec + letzte Approval mit Nutzer → kein Hinweis', () => {
  assert.equal(needsSshReactivation({ status: 'active', approvals: [legacy, withUser] }, true), false);
});
check('ohne ssh.exec oder nicht aktiv → kein Hinweis', () => {
  assert.equal(needsSshReactivation({ status: 'active', approvals: [] }, false), false);
  assert.equal(needsSshReactivation({ status: 'draft', approvals: [] }, true), false);
  assert.equal(needsSshReactivation({ status: 'paused' }, true), false);
  assert.equal(needsSshReactivation(undefined, true), false);
  assert.equal(needsSshReactivation(null, true), false);
});

fs.rmSync(outDir, { recursive: true, force: true });
if (failures) {
  console.error(`${failures} failed`);
  process.exit(1);
}
console.log('workflow-reactivation-check: OK');
