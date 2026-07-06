#!/usr/bin/env node
/*
 * Pure-logic checks for the API-Werkbank curl importer.
 * Loads compiled parser from dist/. Run via
 * `npm run check:http-requests-curl` from backend/ after a build.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); }
  catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}
const { parseCurl } = loadCompiled('http-requests/curl-parser.js');

let failures = 0, total = 0;
function check(label, fn) {
  total += 1;
  try { fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err.message || err}`); }
}

check('simple GET, bare url', () => {
  const r = parseCurl('curl https://api.example.com/health');
  assert.equal(r.method, 'GET');
  assert.equal(r.url, 'https://api.example.com/health');
});

check('method inference: -d implies POST', () => {
  const r = parseCurl(`curl https://x.test/api -d '{"a":1}'`);
  assert.equal(r.method, 'POST');
  assert.equal(r.body.mode, 'raw');
  assert.equal(r.body.raw, '{"a":1}');
});

check('explicit -X overrides inference; headers parsed', () => {
  const r = parseCurl(`curl -X PUT https://x.test/i -H 'Content-Type: application/json' -H "X-Trace: 42" -d '{}'`);
  assert.equal(r.method, 'PUT');
  assert.deepEqual(r.headers.find((h) => h.name === 'X-Trace'), { name: 'X-Trace', value: '42', enabled: true });
  assert.equal(r.body.contentType, 'application/json');
});

check('glued short flags -XPOST and line continuations', () => {
  const r = parseCurl('curl -XPOST \\\n  https://x.test/a \\\n  -H "K: v"');
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://x.test/a');
  assert.equal(r.headers[0].value, 'v');
});

check('basic auth -u maps to auth block', () => {
  const r = parseCurl(`curl -u alice:s3cr3t https://x.test/priv`);
  assert.equal(r.auth.type, 'basic');
  assert.equal(r.auth.username, 'alice');
  assert.equal(r.auth.password, 's3cr3t');
});

check('query string is split into queryParams', () => {
  const r = parseCurl('curl "https://x.test/s?q=hello%20world&page=2"');
  assert.equal(r.url, 'https://x.test/s');
  assert.deepEqual(r.queryParams, [
    { key: 'q', value: 'hello world', enabled: true },
    { key: 'page', value: '2', enabled: true },
  ]);
});

check('-G moves data to query and forces GET', () => {
  const r = parseCurl('curl -G https://x.test/s --data-urlencode "name=a b"');
  assert.equal(r.method, 'GET');
  assert.deepEqual(r.queryParams, [{ key: 'name', value: 'a b', enabled: true }]);
});

check('--form builds multipart formFields', () => {
  const r = parseCurl('curl -F field1=value1 -F field2=value2 https://x.test/up');
  assert.equal(r.method, 'POST');
  assert.equal(r.body.mode, 'multipart');
  assert.deepEqual(r.body.formFields, [
    { key: 'field1', value: 'value1', enabled: true },
    { key: 'field2', value: 'value2', enabled: true },
  ]);
});

check('--location sets followRedirects', () => {
  const r = parseCurl('curl -L https://x.test/r');
  assert.equal(r.followRedirects, true);
});

check('-I sets HEAD', () => {
  const r = parseCurl('curl -I https://x.test/');
  assert.equal(r.method, 'HEAD');
});

check('multiple -d joined with &', () => {
  const r = parseCurl('curl https://x.test/f -d a=1 -d b=2');
  assert.equal(r.body.raw, 'a=1&b=2');
  assert.equal(r.body.contentType, 'application/x-www-form-urlencoded');
});

check('throws when no url present', () => {
  assert.throws(() => parseCurl('curl -X POST -H "A: b"'), /No URL/);
});

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
