#!/usr/bin/env node
/**
 * Shell-sichere Template-Expansion (`expandShellCommand`) — läuft gegen `dist/`,
 * ohne Nest und ohne MongoDB.
 */
const assert = require('node:assert/strict');
const { shellQuote, expandShellCommand } = require('../dist/workflows/nodes/shell-template');

assert.equal(shellQuote("a'b"), "'a'\\''b'");
assert.equal(shellQuote(''), "''");

assert.deepEqual(expandShellCommand('echo {{t}}', { t: 'x; rm -rf ~' }), {
  ok: true,
  command: "echo 'x; rm -rf ~'",
});
assert.deepEqual(expandShellCommand('cd {{{p}}}', { p: '/srv/app' }), { ok: true, command: 'cd /srv/app' });
assert.deepEqual(expandShellCommand('echo {{nodes.a.n}}', { nodes: { a: { n: 3 } } }), {
  ok: true,
  command: "echo '3'",
});
assert.deepEqual(expandShellCommand('echo {{nope}}', {}), { ok: false, missing: ['nope'], invalid: [], quoted: [] });

// Whitespace in den Klammern, context.-Präfix
assert.equal(expandShellCommand('echo {{ context.t }}', { t: 'a' }).command, "echo 'a'");
assert.equal(expandShellCommand('echo {{{ t }}}', { t: 'a b' }).command, 'echo a b');

// Einschleusversuche bleiben im Quote
assert.equal(expandShellCommand('echo {{t}}', { t: "'; id; '" }).command, "echo ''\\''; id; '\\'''");
assert.equal(expandShellCommand('echo {{t}}', { t: '$(id) `id`' }).command, "echo '$(id) `id`'");

// Ersetzte Werte werden nicht erneut als Template gelesen
assert.equal(expandShellCommand('echo {{a}}', { a: '{{b}}', b: 'X' }).command, "echo '{{b}}'");

// Nicht-Strings: JSON; null ist ein Wert, kein fehlender Pfad
assert.equal(expandShellCommand('echo {{o}}', { o: { k: 1 } }).command, `echo '{"k":1}'`);
assert.equal(expandShellCommand('echo {{{n}}}', { n: null }).command, 'echo null');

// Alle fehlenden Pfade, dedupliziert
assert.deepEqual(expandShellCommand('{{a}} {{{b}}} {{a}} {{ok}}', { ok: 1 }), { ok: false, missing: ['a', 'b'], invalid: [], quoted: [] });

// Kein Platzhalter
assert.deepEqual(expandShellCommand('ls -la', {}), { ok: true, command: 'ls -la' });

// Objekt: JSON maskiert NUL als \u0000, bleibt also sicher
assert.equal(expandShellCommand('x {{o}}', { o: { k: 'p\0q' } }).ok, true);
// NUL, Funktion, BigInt -> invalid (fail closed), dedupliziert
assert.deepEqual(expandShellCommand('x {{a}} {{{a}}}', { a: 'p\0q' }), { ok: false, missing: [], invalid: ['a'], quoted: [] });
assert.deepEqual(expandShellCommand('x {{f}}', { f: () => 1 }), { ok: false, missing: [], invalid: ['f'], quoted: [] });
assert.deepEqual(expandShellCommand('x {{b}}', { b: 10n }), { ok: false, missing: [], invalid: ['b'], quoted: [] });
const circ = {};
circ.self = circ;
assert.deepEqual(expandShellCommand('x {{c}}', { c: circ }), { ok: false, missing: [], invalid: ['c'], quoted: [] });

// Prototyp-Schlüssel lösen nicht auf
assert.deepEqual(expandShellCommand('x {{constructor}} {{{toString}}}', {}), {
  ok: false,
  missing: ['constructor', 'toString'],
  invalid: [],
  quoted: [],
});
// Arrays: Index und length sind eigene Eigenschaften
assert.equal(expandShellCommand('x {{l.1}} {{l.length}}', { l: ['a', 'b'] }).command, "x 'b' '2'");

// Platzhalter in Quotes des Templates werden abgelehnt (Final-Review I2):
// "…{{t}}…" ließe $(…)/Backticks im Wert laufen, '…{{t}}…' hebt das Quoting auf.
const evil = { t: '$(id) `id`', nodes: { find: { todo: { title: '$(touch /tmp/x)' } } } };
assert.deepEqual(expandShellCommand('git commit -m "{{nodes.find.todo.title}}"', evil), {
  ok: false,
  missing: [],
  invalid: ['nodes.find.todo.title'],
  quoted: ['nodes.find.todo.title'],
});
assert.deepEqual(expandShellCommand("echo '{{t}}'", evil), { ok: false, missing: [], invalid: ['t'], quoted: ['t'] });
assert.deepEqual(expandShellCommand('echo "pre {{{t}}} post"', evil), { ok: false, missing: [], invalid: ['t'], quoted: ['t'] });
assert.deepEqual(expandShellCommand("echo 'a' \"b {{t}}\"", evil), { ok: false, missing: [], invalid: ['t'], quoted: ['t'] });
// Quote ist vor dem Platzhalter wieder geschlossen -> erlaubt
assert.equal(expandShellCommand("echo 'a' {{t}} \"b\"", evil).command, "echo 'a' '$(id) `id`' \"b\"");
// Single-Quote innerhalb von Double-Quotes öffnet nichts: "it's" {{t}} ist blank
assert.equal(expandShellCommand('echo "it\'s" {{t}}', { t: 'v' }).command, 'echo "it\'s" \'v\'');
// Double-Quote innerhalb von Single-Quotes ebenso: '"' {{t}}
assert.equal(expandShellCommand("echo '\"' {{t}}", { t: 'v' }).command, "echo '\"' 'v'");
// \" außerhalb von Quotes öffnet keinen Quote -> Platzhalter ist blank
assert.equal(expandShellCommand('echo \\"{{t}}', { t: 'v' }).command, "echo \\\"'v'");
// \" innerhalb von Double-Quotes schließt nicht -> weiter in Quotes
assert.deepEqual(expandShellCommand('echo "a\\" {{t}}"', { t: 'v' }).quoted, ['t']);
// Backslash in Single-Quotes maskiert nichts: 'a\' schließt -> danach blank
assert.equal(expandShellCommand("echo 'a\\' {{t}}", { t: 'v' }).command, "echo 'a\\' 'v'");
// Unbalanciertes Quote vor dem Platzhalter -> abgelehnt
assert.deepEqual(expandShellCommand('echo "{{t}}', { t: 'v' }).quoted, ['t']);
// In Quotes und zugleich fehlend: nur als quoted/invalid, nicht als missing
assert.deepEqual(expandShellCommand('echo "{{gibtsnicht}}"', {}), {
  ok: false, missing: [], invalid: ['gibtsnicht'], quoted: ['gibtsnicht'],
});
// Gequotete Literale ohne Platzhalter bleiben unverändert
assert.deepEqual(expandShellCommand('echo "a b" \'c d\' \\$HOME', {}), { ok: true, command: 'echo "a b" \'c d\' \\$HOME' });

// Round-Trip durch die echte Shell
const { execFileSync } = require('node:child_process');
for (const v of ["it's", 'a\nb', '$(id)', '`id`', "'; id; '", 'x; rm -rf ~', '*', '-n']) {
  const r = expandShellCommand('printf %s {{t}}', { t: v });
  assert.equal(r.ok, true);
  assert.equal(execFileSync('sh', ['-c', r.command]).toString(), v);
}
assert.equal(expandShellCommand('echo {{t}}', { t: 'a\nb' }).command, "echo 'a\nb'");
// Round-Trip mit gequoteten Literalen neben dem blanken Platzhalter
for (const v of ["it's", '$(id)', '"', '\\']) {
  const r = expandShellCommand('printf %s "[" {{t}} \'\'"]"', { t: v });
  assert.equal(r.ok, true);
  assert.equal(execFileSync('sh', ['-c', r.command]).toString(), `[${v}]`);
}

console.log('workflow-shell-template-check: OK');
