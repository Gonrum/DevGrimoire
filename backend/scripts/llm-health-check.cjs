const assert = require('node:assert');
const { LlmHealthService } = require('../dist/balancer/llm-health.service');

let t = 1000;
const h = new LlmHealthService(() => t);

assert.strictEqual(h.isHealthy('a'), true, 'fresh endpoint healthy');
h.recordFailure('a'); h.recordFailure('a');
assert.strictEqual(h.isHealthy('a'), true, '2 failures still healthy');
h.recordFailure('a'); // threshold 3 → open
assert.strictEqual(h.isHealthy('a'), false, '3 failures → open');

t += 30_001; // past cooldown
assert.strictEqual(h.isHealthy('a'), true, 'healthy again after cooldown');

h.recordFailure('a'); h.recordFailure('a'); h.recordFailure('a');
h.recordSuccess('a'); // success resets
assert.strictEqual(h.isHealthy('a'), true, 'success resets circuit');

console.log('llm-health-check OK');
