const assert = require('node:assert');
const { EndpointAllocator } = require('../dist/balancer/endpoint-allocator.service');

// Pool: A(prio1,conc2) then B(prio2,conc1). C is unhealthy and must be skipped.
const pool = [
  { id: 'A', provider: 'openai-compatible', baseUrl: 'http://a', model: 'm', concurrency: 2, timeoutMs: 0, visionCapable: false },
  { id: 'C', provider: 'openai-compatible', baseUrl: 'http://c', model: 'm', concurrency: 5, timeoutMs: 0, visionCapable: false },
  { id: 'B', provider: 'openai-compatible', baseUrl: 'http://b', model: 'm', concurrency: 1, timeoutMs: 0, visionCapable: false },
];
const endpoints = { listForPool: async () => pool };
const health = { isHealthy: (id) => id !== 'C' };
const alloc = new EndpointAllocator(endpoints, health);

(async () => {
  const s1 = await alloc.acquire('chat'); assert.strictEqual(s1.id, 'A', 'first fills A');
  const s2 = await alloc.acquire('chat'); assert.strictEqual(s2.id, 'A', 'A has conc 2');
  const s3 = await alloc.acquire('chat'); assert.strictEqual(s3.id, 'B', 'overflow to B (C skipped)');
  const s4 = await alloc.acquire('chat'); assert.strictEqual(s4, null, 'pool full → null');

  assert.strictEqual(await alloc.poolCapacity('chat'), 3, 'capacity = A(2)+B(1), C unhealthy');

  alloc.release('A');
  const s5 = await alloc.acquire('chat'); assert.strictEqual(s5.id, 'A', 'released slot reused');

  console.log('endpoint-allocator-check OK');
})().catch((e) => { console.error(e); process.exit(1); });
