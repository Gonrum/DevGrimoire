// Verifies the apiKey merge semantics: undefined=keep, ''=clear, value=re-encrypt.
const assert = require('node:assert');
const { resolveApiKeyEnc } = require('../dist/balancer/llm-endpoints.service');

// Fake encryption: prefix so we can assert "re-encrypted".
const enc = { isEnabled: () => true, encrypt: (s) => 'ENC(' + s + ')', decrypt: (s) => s.slice(4, -1) };

// undefined → keep previous ciphertext untouched
assert.strictEqual(resolveApiKeyEnc(enc, 'ENC(old)', undefined), 'ENC(old)');
// '' → clear
assert.strictEqual(resolveApiKeyEnc(enc, 'ENC(old)', ''), undefined);
// value → encrypt fresh
assert.strictEqual(resolveApiKeyEnc(enc, 'ENC(old)', 'new'), 'ENC(new)');
// undefined with no previous → stays undefined
assert.strictEqual(resolveApiKeyEnc(enc, undefined, undefined), undefined);

console.log('llm-endpoints-merge-check OK');
