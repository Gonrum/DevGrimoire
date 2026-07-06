const assert = require('node:assert');
const { mergeMigrated } = require('../dist/balancer/llm-registry-migrator.service');

// Same server used for chat AND workflow → ONE endpoint, merged purposes.
const chat = [{ provider: 'openai-compatible', url: 'http://gpu:1234', model: 'qwen', apiKey: 'k', visionCapable: true }];
const workflow = [{ provider: 'openai-compatible', url: 'http://gpu:1234', model: 'qwen', apiKey: 'k' }];
const embed = [{ provider: 'ollama', url: 'http://gpu:11434', model: 'nomic' }];

const out = mergeMigrated(chat, embed, workflow);
assert.strictEqual(out.length, 2, 'gpu:1234 merged, ollama separate');

const merged = out.find((e) => e.baseUrl === 'http://gpu:1234');
assert.deepStrictEqual(merged.purposes.sort(), ['chat', 'workflow']);
assert.strictEqual(merged.visionCapable, true, 'vision flag preserved from chat');
assert.strictEqual(merged.priority, 0, 'first chat endpoint keeps priority 0');

const emb = out.find((e) => e.baseUrl === 'http://gpu:11434');
assert.deepStrictEqual(emb.purposes, ['embedding']);

// lmstudio provider collapses to openai-compatible
const ls = mergeMigrated([{ provider: 'lmstudio', url: 'http://x:1234', model: 'm' }], [], []);
assert.strictEqual(ls[0].provider, 'openai-compatible', 'lmstudio → openai-compatible');

console.log('llm-migrator-merge-check OK');
