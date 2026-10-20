#!/usr/bin/env node
/**
 * Mehrzeilige ssh.exec-Skripte: Zeilen zerlegen, Skript mit Markern bauen,
 * Ausgabe pro Zeile zuordnen. Das gebaute Skript läuft in einer **echten**
 * lokalen bash — genau so, wie es der SSH-Server bekäme. Nach `npm run build`.
 */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  splitCommandLines,
  buildScript,
  parseScriptOutput,
  lineFailureMessage,
} = require('../dist/workflows/nodes/ssh-script');
const { sshTimeouts } = require('../dist/workflows/nodes/ssh-exec.executor');

const NONCE = 'a1b2c3d4e5f6';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n`, err);
    process.exitCode = 1;
  }
}

function asLines(commands) {
  return commands.map((command, i) => ({ line: i + 1, command }));
}

/** Echte Shell; stdout/stderr auch bei Exit ≠ 0 (execFileSync würfe dann). */
function runBash(script) {
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status };
}

check('splitCommandLines: Leer-/Kommentarzeilen entfallen, \\ verbindet, Startzeile bleibt', () => {
  assert.deepEqual(splitCommandLines('cd /x\n\n# c\nexport A=1 \\\n  B=2\nls'), [
    { line: 1, command: 'cd /x' },
    { line: 4, command: 'export A=1 B=2' },
    { line: 6, command: 'ls' },
  ]);
});

check('splitCommandLines: CRLF, Kommentar mit \\ verbindet nicht, \\ am Ende entfällt, \\\\ ist kein Umbruch', () => {
  assert.deepEqual(splitCommandLines('a\r\n  # k \\\nb\\\\\nc \\'), [
    { line: 1, command: 'a' },
    { line: 3, command: 'b\\\\' },
    { line: 4, command: 'c' },
  ]);
  assert.deepEqual(splitCommandLines('\n  \n# nur Kommentar'), []);
});

check('echte Shell, failFast: eine Shell (cd/export wirken weiter), Zuordnung, Abbruch nach exit 3', () => {
  const lines = asLines(['cd /tmp', 'export X=7', 'echo "$X $(pwd)"', 'echo err >&2', 'exit 3', 'echo nie']);
  const out = runBash(buildScript(lines, { nonce: NONCE, failFast: true }));
  const r = parseScriptOutput(lines, out, NONCE);
  assert.equal(r.lines.length, 5, JSON.stringify(r.lines));
  assert.equal(r.lines[2].stdout, '7 /tmp\n');
  assert.equal(r.lines[2].exitCode, 0);
  assert.equal(r.lines[3].stderr, 'err\n');
  assert.equal(r.lines[3].stdout, '');
  assert.equal(r.lines[4].line, 5);
  assert.equal(r.lines[4].command, 'exit 3');
  assert.equal(r.lines[4].exitCode, 3);
  assert.equal(r.lastExitCode, 3);
  assert.ok(!r.lines.some((l) => l.command === 'echo nie'));
  assert.ok(!r.stdout.includes('__DG_'), r.stdout);
  assert.ok(!r.stderr.includes('__DG_'), r.stderr);
  assert.equal(r.stdout, '7 /tmp\n');
  assert.equal(r.stderr, 'err\n');
  for (const l of r.lines.slice(0, 4)) {
    assert.ok(l.durationMs === null || (Number.isInteger(l.durationMs) && l.durationMs >= 0), String(l.durationMs));
  }
});

check('echte Shell, ohne failFast: weiter nach Fehler, Exit-Code je Zeile', () => {
  const lines = asLines(['false', 'echo weiter']);
  const out = runBash(buildScript(lines, { nonce: NONCE, failFast: false }));
  const r = parseScriptOutput(lines, out, NONCE);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].exitCode, 1);
  assert.equal(r.lines[1].exitCode, 0);
  assert.equal(r.lines[1].stdout, 'weiter\n');
  assert.equal(r.lastExitCode, 0);
});

check('echte Shell: letzte Zeile scheitert ohne failFast → Prozess-Exit-Code ist ihrer', () => {
  const lines = asLines(['true', 'exit_nicht_vorhanden_xyz 2>/dev/null']);
  const out = runBash(buildScript(lines, { nonce: NONCE, failFast: false }));
  assert.equal(out.exitCode, 127);
  const r = parseScriptOutput(lines, out, NONCE);
  assert.equal(r.lastExitCode, 127);
});

check('Spoof: Marker mit fremder Nonce bleibt Ausgabe der Zeile', () => {
  const lines = asLines(['echo "__DG_000000000000_0_E_0_1"', 'echo zwei']);
  const out = runBash(buildScript(lines, { nonce: NONCE, failFast: true }));
  const r = parseScriptOutput(lines, out, NONCE);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].stdout, '__DG_000000000000_0_E_0_1\n');
  assert.equal(r.lines[1].stdout, 'zwei\n');
  assert.equal(r.lines[0].exitCode, 0);
});

check('Ausgabe ohne Zeilenende wird nicht mit Markern verklebt', () => {
  const lines = asLines(['printf abc', 'printf def']);
  const out = runBash(buildScript(lines, { nonce: NONCE, failFast: true }));
  const r = parseScriptOutput(lines, out, NONCE);
  assert.equal(r.lines[0].stdout, 'abc');
  assert.equal(r.lines[1].stdout, 'def');
  assert.equal(r.stdout, 'abcdef');
});

check('Abbruch: Zeile 2 gestartet, nie beendet → aborted idle_timeout + Meldung', () => {
  const lines = asLines(['echo eins', 'sleep 999', 'echo drei']);
  const full = runBash(buildScript(asLines(['echo eins', 'true']), { nonce: NONCE, failFast: true })).stdout;
  // stdout nur bis einschließlich Start-Marker von Zeile 2 (Index 1).
  const cut = full.indexOf(`__DG_${NONCE}_1_S_`);
  assert.ok(cut > 0);
  const stdout = full.slice(0, full.indexOf('\n', cut) + 1) + 'teil';
  const r = parseScriptOutput(lines, { stdout, stderr: '', exitCode: null, aborted: 'idle_timeout' }, NONCE);
  assert.equal(r.lines.length, 2);
  const last = r.lines[1];
  assert.equal(last.line, 2);
  assert.equal(last.aborted, 'idle_timeout');
  assert.equal(last.exitCode, null);
  assert.equal(last.durationMs, null);
  assert.equal(last.stdout, 'teil');
  assert.equal(r.lines[0].aborted, undefined);
  assert.equal(r.lastExitCode, null);
  assert.equal(lineFailureMessage(last, { timeoutMs: 595000, idleTimeoutMs: 30000 }), 'Zeile 2 abgebrochen: 30 s ohne Ausgabe');
  assert.equal(
    lineFailureMessage({ ...last, aborted: 'timeout' }, { timeoutMs: 595000, idleTimeoutMs: 30000 }),
    'Zeile 2 abgebrochen: Zeitlimit 595 s erreicht',
  );
  assert.equal(
    lineFailureMessage({ ...last, aborted: undefined, exitCode: 4 }, { timeoutMs: 595000, idleTimeoutMs: 30000 }),
    'Zeile 2 endete mit Exit-Code 4',
  );
});

check('nicht numerische Zeitstempel → durationMs null', () => {
  const lines = asLines(['echo x']);
  const stdout = `\n__DG_${NONCE}_0_S_\nx\n\n__DG_${NONCE}_0_E_0_17000003N\n`;
  const r = parseScriptOutput(lines, { stdout, stderr: '', exitCode: 0 }, NONCE);
  assert.equal(r.lines[0].durationMs, null);
  assert.equal(r.lines[0].stdout, 'x\n');
  const ok = parseScriptOutput(lines, {
    stdout: `\n__DG_${NONCE}_0_S_1000\nx\n\n__DG_${NONCE}_0_E_0_1250\n`, stderr: '', exitCode: 0,
  }, NONCE);
  assert.equal(ok.lines[0].durationMs, 250);
});

check('sshTimeouts: Leerlauf-Default 30 s, 0 bleibt 0', () => {
  assert.equal(sshTimeouts({}).idleTimeoutMs, 30000);
  assert.equal(sshTimeouts({ idleTimeoutMs: 0 }).idleTimeoutMs, 0);
  assert.equal(sshTimeouts({ timeoutMs: 10000 }).idleTimeoutMs, 5000);
});

console.log(`${passed} passed`);
