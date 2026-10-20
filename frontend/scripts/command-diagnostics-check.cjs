#!/usr/bin/env node
/**
 * Diagnosen des Shell-Editors (ssh.exec.command).
 * Übersetzt die importfreie `src/lib/command-diagnostics.ts` nach CommonJS
 * (Muster: placeholder-view-check.cjs).
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-command-diagnostics-'));
try {
  execFileSync('npx', ['tsc', 'src/lib/command-diagnostics.ts', '--outDir', outDir, '--module', 'commonjs', '--target', 'ES2020', '--skipLibCheck'],
    { cwd: root, stdio: 'pipe' });
} catch (err) {
  console.error('tsc-Übersetzung fehlgeschlagen:');
  console.error(err.stdout ? err.stdout.toString() : err.message);
  process.exit(1);
}
const { commandDiagnostics } = require(path.join(outDir, 'command-diagnostics.js'));

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`✓ ${label}`); } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
  }
}

const trace = (over) => ({ field: 'command', line: 1, expr: 'x.y', raw: false, status: 'resolved', ...over });

check('Platzhalter in doppelten Anführungszeichen -> Fehler in Zeile 2', () => {
  assert.deepEqual(commandDiagnostics('ls\necho "{{nodes.a.x}}"', []),
    [{ line: 2, severity: 'error', message: 'Platzhalter nicht in Anführungszeichen setzen' }]);
});
check('Platzhalter in einfachen Anführungszeichen -> Fehler', () => {
  assert.equal(commandDiagnostics("echo '{{{nodes.a.x}}}'", []).length, 1);
});
check('Platzhalter ausserhalb von Anführungszeichen -> keine Diagnose', () => {
  assert.deepEqual(commandDiagnostics('echo "a" {{nodes.a.x}} \'b\'', []), []);
});
check('Anführungszeichen in anderer Zeile zählen nicht', () => {
  assert.deepEqual(commandDiagnostics('echo "a"\n{{nodes.a.x}}\necho "b"', []), []);
});
check('missing -> Fehler in der Spur-Zeile', () => {
  assert.deepEqual(commandDiagnostics('a\nb\nc', [trace({ line: 3, status: 'missing' })]),
    [{ line: 3, severity: 'error', message: 'Platzhalter nicht auflösbar: x.y' }]);
});
check('secret_forbidden -> Fehler', () => {
  const d = commandDiagnostics('a', [trace({ expr: 'secrets.K', status: 'secret_forbidden' })]);
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'error');
});
check('unknown -> Warnung', () => {
  assert.deepEqual(commandDiagnostics('a', [trace({ status: 'unknown' })]),
    [{ line: 1, severity: 'warning', message: 'Wert erst nach Trockenlauf bekannt' }]);
});
check('resolved/empty/secret -> keine Diagnose', () => {
  assert.deepEqual(commandDiagnostics('a', [trace({ status: 'resolved' }), trace({ status: 'empty' }), trace({ status: 'secret' })]), []);
});
check('Spur mit field cwd wird ignoriert', () => {
  assert.deepEqual(commandDiagnostics('a', [trace({ field: 'cwd', status: 'missing' })]), []);
});
check('Zeile ausserhalb des Textes wird auf gültigen Bereich geklemmt', () => {
  const d = commandDiagnostics('a', [trace({ line: 9, status: 'missing' })]);
  assert.equal(d[0].line, 1);
});

if (failures > 0) { console.error(`\n${failures} Check(s) fehlgeschlagen`); process.exit(1); }
console.log('\nAlle Checks grün');
