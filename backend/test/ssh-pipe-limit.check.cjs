'use strict';
const assert = require('node:assert');
const { Readable, PassThrough } = require('node:stream');
const { pipeToSftpWithLimit } = require('../dist/ssh/upload-limit.util');

async function underLimit() {
  const sink = new PassThrough();
  const chunks = [];
  sink.on('data', (c) => chunks.push(c));
  const bytes = await pipeToSftpWithLimit(sink, Readable.from([Buffer.alloc(100)]), 1000);
  assert.strictEqual(bytes, 100);
  assert.strictEqual(Buffer.concat(chunks).length, 100);
}

async function overLimit() {
  const sink = new PassThrough();
  sink.resume(); // drain so backpressure doesn't stall the test
  const big = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]);
  await assert.rejects(
    () => pipeToSftpWithLimit(sink, big, 1000),
    /upload_too_large/,
  );
}

(async () => {
  await underLimit();
  await overLimit();
  console.log('ssh-pipe-limit.check.cjs OK');
})().catch((e) => { console.error(e); process.exit(1); });
