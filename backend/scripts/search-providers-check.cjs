const assert = require('node:assert');
const { TavilyProvider } = require('../dist/web-search/providers/tavily.provider');
const { BraveProvider } = require('../dist/web-search/providers/brave.provider');
const { SerpApiProvider } = require('../dist/web-search/providers/serpapi.provider');

const tav = new TavilyProvider({ axiosRef: { post: async () => ({ data: { results: [
  { title: 'T', url: 'https://t', content: 'c', score: 0.9 } ] } }) } }, { apiKey: 'k' });
const bra = new BraveProvider({ axiosRef: { get: async () => ({ data: { web: { results: [
  { title: 'B', url: 'https://b', description: 'd' } ] } } }) } }, { apiKey: 'k' });
const serp = new SerpApiProvider({ axiosRef: { get: async () => ({ data: { organic_results: [
  { title: 'S', link: 'https://s', snippet: 's' } ] } }) } }, { apiKey: 'k' });
(async () => {
  assert.strictEqual((await tav.search('q', {}))[0].snippet, 'c');
  assert.strictEqual((await bra.search('q', {}))[0].snippet, 'd', 'brave description→snippet');
  assert.strictEqual((await serp.search('q', {}))[0].url, 'https://s', 'serp link→url');
  console.log('search-providers-check OK');
})().catch((e) => { console.error(e); process.exit(1); });

// Eigene Endpoints (Self-Host/Proxy): URL-Formen und Auth-Header.
const { braveEndpoint, tavilySearchEndpoint } = require('../dist/web-search/providers/endpoint-url');
assert.strictEqual(braveEndpoint(), 'https://api.search.brave.com/res/v1/web/search');
assert.strictEqual(braveEndpoint('https://brave.intern'), 'https://brave.intern/res/v1/web/search');
assert.strictEqual(braveEndpoint('https://brave.intern/'), 'https://brave.intern/res/v1/web/search');
assert.strictEqual(braveEndpoint('http://10.0.0.5:8080/api/search/'), 'http://10.0.0.5:8080/api/search');
assert.strictEqual(tavilySearchEndpoint(), 'https://api.tavily.com/search');
assert.strictEqual(tavilySearchEndpoint('https://tav.intern/'), 'https://tav.intern/search');
assert.strictEqual(tavilySearchEndpoint('https://tav.intern/search'), 'https://tav.intern/search');
assert.strictEqual(tavilySearchEndpoint('https://tav.intern/v1/search/'), 'https://tav.intern/v1/search');

(async () => {
  const seen = {};
  const braveNoKey = new BraveProvider({ axiosRef: { get: async (url, cfg) => {
    seen.braveUrl = url; seen.braveHeaders = cfg.headers; return { data: {} };
  } } }, { apiKey: '', baseUrl: 'https://brave.intern' });
  await braveNoKey.search('q', {});
  assert.strictEqual(seen.braveUrl, 'https://brave.intern/res/v1/web/search');
  assert.ok(!('X-Subscription-Token' in seen.braveHeaders), 'kein leerer Token-Header ohne Key');

  const tavKey = new TavilyProvider({ axiosRef: { post: async (url, body, cfg) => {
    seen.tavUrl = url; seen.tavBody = body; seen.tavHeaders = cfg.headers; return { data: {} };
  } } }, { apiKey: 'tvly-x', baseUrl: 'https://tav.intern/search' });
  await tavKey.search('q', {});
  assert.strictEqual(seen.tavUrl, 'https://tav.intern/search', 'kein /search/search');
  assert.strictEqual(seen.tavHeaders.Authorization, 'Bearer tvly-x');
  assert.strictEqual(seen.tavBody.api_key, 'tvly-x');

  const tavNoKey = new TavilyProvider({ axiosRef: { post: async (_u, body, cfg) => {
    seen.tavBody2 = body; seen.tavHeaders2 = cfg.headers; return { data: {} };
  } } }, { apiKey: '' });
  await tavNoKey.search('q', {});
  assert.ok(!('api_key' in seen.tavBody2) && !('Authorization' in seen.tavHeaders2), 'ohne Key keine Auth');
  console.log('search-providers-check (custom endpoints) OK');
})().catch((e) => { console.error(e); process.exit(1); });
