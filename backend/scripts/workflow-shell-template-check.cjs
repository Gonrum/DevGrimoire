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
assert.deepEqual(expandShellCommand('echo {{nope}}', {}), { ok: false, missing: ['nope'], invalid: [] });

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
assert.deepEqual(expandShellCommand('{{a}} {{{b}}} {{a}} {{ok}}', { ok: 1 }), { ok: false, missing: ['a', 'b'], invalid: [] });

// Kein Platzhalter
assert.deepEqual(expandShellCommand('ls -la', {}), { ok: true, command: 'ls -la' });

// Objekt: JSON maskiert NUL als \u0000, bleibt also sicher
assert.equal(expandShellCommand('x {{o}}', { o: { k: 'p\0q' } }).ok, true);
// NUL, Funktion, BigInt -> invalid (fail closed), dedupliziert
assert.deepEqual(expandShellCommand('x {{a}} {{{a}}}', { a: 'p\0q' }), { ok: false, missing: [], invalid: ['a'] });
assert.deepEqual(expandShellCommand('x {{f}}', { f: () => 1 }), { ok: false, missing: [], invalid: ['f'] });
assert.deepEqual(expandShellCommand('x {{b}}', { b: 10n }), { ok: false, missing: [], invalid: ['b'] });
const circ = {};
circ.self = circ;
assert.deepEqual(expandShellCommand('x {{c}}', { c: circ }), { ok: false, missing: [], invalid: ['c'] });

// Prototyp-Schlüssel lösen nicht auf
assert.deepEqual(expandShellCommand('x {{constructor}} {{{toString}}}', {}), {
  ok: false,
  missing: ['constructor', 'toString'],
  invalid: [],
});
// Arrays: Index und length sind eigene Eigenschaften
assert.equal(expandShellCommand('x {{l.1}} {{l.length}}', { l: ['a', 'b'] }).command, "x 'b' '2'");

// Round-Trip durch die echte Shell
const { execFileSync } = require('node:child_process');
for (const v of ["it's", 'a\nb', '$(id)', '`id`', "'; id; '", 'x; rm -rf ~', '*', '-n']) {
  const r = expandShellCommand('printf %s {{t}}', { t: v });
  assert.equal(r.ok, true);
  assert.equal(execFileSync('sh', ['-c', r.command]).toString(), v);
}
assert.equal(expandShellCommand('echo {{t}}', { t: 'a\nb' }).command, "echo 'a\nb'");

console.log('workflow-shell-template-check: OK');
