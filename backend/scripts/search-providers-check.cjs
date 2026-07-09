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
