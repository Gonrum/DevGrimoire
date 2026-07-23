'use strict';
const assert = require('node:assert');
const { Readable } = require('node:stream');
const { WorkspaceClient } = require('../dist/workspaces/workspace-client.service');

process.env.WORKSPACE_API_TOKEN = 'test-token-0123456789';
const client = new WorkspaceClient({ /* HttpService unused on this path */ });

const origFetch = global.fetch;
global.fetch = async () => ({
  ok: true,
  headers: { get: (k) => (k.toLowerCase() === 'content-length' ? '3' : null) },
  body: Readable.toWeb(Readable.from([Buffer.from('abc')])),
});

(async () => {
  const { stream, size } = await client.readStream('deadbeefdeadbeefdeadbeef', 'f.bin');
  assert.strictEqual(size, 3);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  assert.strictEqual(Buffer.concat(chunks).toString(), 'abc');
  global.fetch = origFetch;
  console.log('workspace-readstream.check.cjs OK');
})().catch((e) => { console.error(e); process.exit(1); });
