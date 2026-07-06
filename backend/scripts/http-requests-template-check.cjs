#!/usr/bin/env node
/*
 * Pure-logic checks for the API-Werkbank template resolver + secret masking.
 * Loads compiled helpers from dist/. Run via
 * `npm run check:http-requests-template` from backend/ after a build.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const {
  buildResolutionContext,
  resolveTemplates,
  resolveRequest,
  maskSecrets,
} = loadCompiled('http-requests/template-resolver.js');

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err.message || err}`); }
}

check('precedence: env-secret > variable > global-secret', () => {
  const ctx = buildResolutionContext({
    globalSecrets: [{ key: 'TOKEN', value: 'global' }],
    variables: [{ key: 'TOKEN', value: 'var' }],
    envSecrets: [{ key: 'TOKEN', value: 'envsecret' }],
  });
  assert.equal(ctx.values.get('TOKEN'), 'envsecret');
});

check('resolveTemplates replaces known keys, records unknown', () => {
  const ctx = buildResolutionContext({ globalSecrets: [], variables: [{ key: 'HOST', value: 'api.x' }], envSecrets: [] });
  const unresolved = new Set();
  const out = resolveTemplates('https://{{HOST}}/v1/{{MISSING}}', ctx, unresolved);
  assert.equal(out, 'https://api.x/v1/{{MISSING}}');
  assert.deepEqual([...unresolved], ['MISSING']);
});

check('resolveRequest resolves url, header value, body raw', () => {
  const ctx = buildResolutionContext({ globalSecrets: [{ key: 'KEY', value: 'sk-live-123' }], variables: [{ key: 'HOST', value: 'api.x' }], envSecrets: [] });
  const resolved = resolveRequest({
    method: 'POST',
    url: 'https://{{HOST}}/pay',
    headers: [{ name: 'X-Api-Key', value: '{{KEY}}', enabled: true }],
    body: { mode: 'raw', raw: '{"k":"{{KEY}}"}' },
  }, ctx);
  assert.equal(resolved.url, 'https://api.x/pay');
  assert.equal(resolved.headers[0].value, 'sk-live-123');
  assert.equal(resolved.body.raw, '{"k":"sk-live-123"}');
  assert.deepEqual(resolved.unresolved, []);
});

check('maskSecrets redacts every occurrence, longest-first', () => {
  const masked = maskSecrets('key=sk-live-123 short=abc again sk-live-123', ['abc', 'sk-live-123']);
  assert.equal(masked, 'key=*** short=*** again ***');
});

check('maskSecrets ignores empty secret values (no over-masking)', () => {
  const masked = maskSecrets('nothing to hide', ['', undefined]);
  assert.equal(masked, 'nothing to hide');
});

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
