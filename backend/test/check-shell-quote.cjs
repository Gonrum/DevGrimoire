#!/usr/bin/env node
/*
 * shq(): exact outputs, NUL rejection and a round trip through a real `sh -c`
 * for awkward values. Loads from dist/; run `npm run build` first.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const abs = path.resolve(__dirname, '..', 'dist', 'common/shell-quote.js');
let mod;
try { mod = require(abs); } catch (err) {
  console.error(`Failed to load ${abs}. Run \`npm run build\` first.\n${err.message}`);
  process.exit(2);
}
const { shq } = mod;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`ok   ${name}`); } catch (err) { failures++; console.error(`FAIL ${name}\n     ${err.message}`); }
}

check('plain value is wrapped', () => assert.equal(shq('a b'), "'a b'"));
check('single quote is escaped', () => assert.equal(shq("it's"), "'it'\\''s'"));
check('leading dash stays one word', () => assert.equal(shq('-rf'), "'-rf'"));
check('empty string', () => assert.equal(shq(''), "''"));
check('NUL throws', () => assert.throws(() => shq('a\0b'), /shell argument contains NUL/));

const CASES = ['a b', "it's", '-rf', '$(id)', 'line1\nline2', '`id`', 'a;b', '', "'", "''", '$(id)\n;x', 'a\\b', '*', '~', '"q"', 'tab\there'];
for (const v of CASES) {
  check(`sh round trip ${JSON.stringify(v)}`, () => {
    const out = execFileSync('sh', ['-c', `printf %s ${shq(v)}`], { encoding: 'utf8' });
    assert.equal(out, v);
  });
}
check('sh sees exactly one argument', () => {
  const v = '$(id) ; rm -rf x\n`y` \'z\'';
  const out = execFileSync('sh', ['-c', `set -- ${shq(v)}; printf %s "$#"`], { encoding: 'utf8' });
  assert.equal(out, '1');
});

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log('all shell-quote checks passed');
