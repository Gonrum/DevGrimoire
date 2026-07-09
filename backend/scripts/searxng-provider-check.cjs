const assert = require('node:assert');
const { SearxngProvider } = require('../dist/web-search/providers/searxng.provider');
const httpMock = { axiosRef: { get: async () => ({ data: { results: [
  { title: 'T', url: 'https://x', content: 'snip', engine: 'ddg', score: 1.2 } ] } }) } };
const provider = new SearxngProvider(httpMock, async () => 'http://searxng:8080');
(async () => {
  const out = await provider.search('foo', { limit: 2, language: 'de' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].snippet, 'snip', 'content maps to snippet');
  assert.strictEqual(out[0].url, 'https://x');
  console.log('searxng-provider-check OK');
})().catch((e) => { console.error(e); process.exit(1); });
