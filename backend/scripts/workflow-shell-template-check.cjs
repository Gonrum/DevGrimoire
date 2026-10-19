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
assert.deepEqual(expandShellCommand('echo {{nope}}', {}), { ok: false, missing: ['nope'] });

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
assert.deepEqual(expandShellCommand('{{a}} {{{b}}} {{a}} {{ok}}', { ok: 1 }), { ok: false, missing: ['a', 'b'] });

// Kein Platzhalter
assert.deepEqual(expandShellCommand('ls -la', {}), { ok: true, command: 'ls -la' });

console.log('workflow-shell-template-check: OK');
