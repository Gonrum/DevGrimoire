#!/usr/bin/env node
/*
 * Tool-Notifications dürfen keine schutzbedürftigen Argumente tragen.
 *
 * formatToolBody kopierte die ersten 80 Zeichen jedes Arguments in den Text
 * der Notification — bei `secret_set` den Klartext-Wert (`value`), bei
 * `kube_apply` das Manifest. Jetzt nach Argumentnamen ausgeblendet.
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

const { formatToolBody } = loadCompiled('mcp-tools.js');

const EXPECTED_CHECKS = 3;
let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const MARKER = 'GEHEIM-4711';

check('secret_set: der Wert steht nicht im Text', () => {
  const body = formatToolBody('secret_set', { projectId: 'p', key: 'DB_PASSWORD', value: MARKER }, { key: 'DB_PASSWORD' });
  assert.ok(!body.includes(MARKER), body);
});

check('Argumente mit Namen wie password/token/apiKey/privateKey werden ausgeblendet', () => {
  for (const k of ['password', 'token', 'apiKey', 'privateKey', 'passphrase', 'clientSecret', 'authorization', 'yaml', 'content']) {
    const body = formatToolBody('x_update', { [k]: MARKER }, {});
    assert.ok(!body.includes(MARKER), `${k}: ${body}`);
  }
});

check('harmlose Argumente erscheinen weiter', () => {
  const body = formatToolBody('todo_update', { status: 'done', priority: 'high' }, { title: 'T' });
  assert.match(body, /T/);
  assert.match(body, /status: done/);
});

console.log(`\n${total - failures}/${total} passed`);
if (total !== EXPECTED_CHECKS) { console.error(`Erwartet ${EXPECTED_CHECKS} Checks, gelaufen ${total}`); process.exit(1); }
process.exit(failures === 0 ? 0 : 1);
