const assert = require('node:assert');
const { WebSearchConfigService, resolveTestApiKey } = require('../dist/web-search/services/web-search-config.service');
const store = new Map();
const settings = { get: async (k) => store.get(k) ?? null, set: async (k, v) => store.set(k, v) };
const enc = { isEnabled: () => true, encrypt: (s) => 'ENC(' + s + ')', decrypt: (s) => s.slice(4, -1) };
const svc = new WebSearchConfigService(settings, enc, null);
(async () => {
  await svc.setConfig({ activeProvider: 'tavily', providers: [{ type: 'tavily', apiKey: 'sk' }] });
  const raw = JSON.parse(store.get('web_search_config'));
  assert.ok(raw.providers[0].apiKeyEnc === 'ENC(sk)' && !('apiKey' in raw.providers[0]));
  const pub = await svc.getConfig();
  assert.strictEqual(pub.providers[0].hasApiKey, true);
  assert.ok(!('apiKey' in pub.providers[0]));
  await svc.setConfig({ activeProvider: 'tavily', providers: [{ type: 'tavily', apiKey: '' }] });
  assert.ok(!JSON.parse(store.get('web_search_config')).providers[0].apiKeyEnc, 'empty deletes key');
  const encOff = { ...enc, isEnabled: () => false };
  const svc2 = new WebSearchConfigService(settings, encOff, null);
  await assert.rejects(() => svc2.setConfig({ activeProvider: 'brave', providers: [{ type: 'brave', apiKey: 'x' }] }));

  // resolveTestApiKey: pure fallback-resolution used by the "Test" endpoint so
  // an omitted apiKey (masked/untouched field) still validates against the
  // stored key instead of silently testing with ''.
  const decrypt = (s) => 'DECRYPTED(' + s + ')';
  assert.strictEqual(
    resolveTestApiKey('candidate-key', 'ENC(stored)', decrypt),
    'candidate-key',
    'provided key wins over stored',
  );
  assert.strictEqual(
    resolveTestApiKey(undefined, 'ENC(stored)', decrypt),
    'DECRYPTED(ENC(stored))',
    'omitted + stored falls back to decrypted stored key',
  );
  assert.strictEqual(
    resolveTestApiKey('', 'ENC(stored)', decrypt),
    'DECRYPTED(ENC(stored))',
    'empty-string provided key is treated as omitted, falls back to stored',
  );
  assert.strictEqual(
    resolveTestApiKey(undefined, undefined, decrypt),
    '',
    'omitted + no stored key resolves to empty string (keyless probe)',
  );

  // Wire-up: testProvider() must resolve the *effective* key — a previously
  // saved provider whose masked key was left untouched (apiKey: undefined)
  // must be probed with the stored key, not fail as if keyless.
  await svc.setConfig({ activeProvider: 'tavily', providers: [{ type: 'tavily', apiKey: 'stored-secret' }] });
  const seenKeys = [];
  const originalInstantiate = svc.instantiateProvider.bind(svc);
  svc.instantiateProvider = (type, apiKey, _baseUrl) => {
    seenKeys.push(apiKey);
    return { search: async () => [] };
  };
  await svc.testProvider({ type: 'tavily', apiKey: undefined });
  assert.strictEqual(seenKeys[seenKeys.length - 1], 'stored-secret', 'testProvider falls back to stored key when apiKey omitted');
  await svc.testProvider({ type: 'tavily', apiKey: 'fresh-candidate' });
  assert.strictEqual(seenKeys[seenKeys.length - 1], 'fresh-candidate', 'testProvider prefers a freshly provided candidate key');
  svc.instantiateProvider = originalInstantiate;

  console.log('web-search-config-check OK');
})().catch((e) => { console.error(e); process.exit(1); });
