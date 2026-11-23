#!/usr/bin/env node
/*
 * Big-body middleware for `PUT /api/workspaces/:id/fs/file` (main.ts runs it
 * before the Nest guards). Pinned with a real Express app and small limits
 * (global 1 KiB, big 4 KiB):
 *  - other routes / methods: untouched (global limit applies)
 *  - no credential: the big parser never runs, the global limit rejects
 *  - credential: bodies above the global limit are parsed
 *  - credential + over the big cap: JSON 413 { error, message, limit }
 *  - missing Content-Length (chunked): untouched, authenticate never asked
 *  - a body within the global limit never triggers authentication
 *
 * Loads from dist/; run `npm run build` first. Local sockets only.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createFsFileBodyMiddleware } = require(path.resolve(__dirname, '..', 'dist', 'workspaces', 'fs-file-body.middleware.js'));
const express = require(path.resolve(__dirname, '..', 'node_modules', 'express'));

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`ok  ${label}`); }
  catch (err) { failures += 1; console.error(`FAIL ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const GLOBAL = 1024, BIG = 4096, EDITOR = 777;
let authCalls = 0;

function start() {
  const app = express();
  app.use(createFsFileBodyMiddleware({
    authenticate: async (req) => { authCalls += 1; return req.headers.authorization === 'Bearer good'; },
    editorLimit: async () => EDITOR,
    bigLimitBytes: BIG,
    globalLimitBytes: GLOBAL,
    parser: express.json({ limit: BIG }),
  }));
  app.use(express.json({ limit: GLOBAL }));
  app.use((req, res) => res.json({ parsed: Object.keys(req.body ?? {}).length }));
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: 'global', type: err.type }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function send(port, method, urlPath, body, headers = {}, { chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const h = { 'content-type': 'application/json', ...headers };
    if (!chunked) h['content-length'] = String(data.length);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    req.on('error', reject);
    if (chunked) { req.write(data); setImmediate(() => req.end()); } else req.end(data);
  });
}
const json = (n) => JSON.stringify({ content: 'a'.repeat(n) });
const ROUTE = '/api/workspaces/abc/fs/file';

(async () => {
  const server = await start();
  const { port } = server.address();
  try {
    await check('body within the global limit: parsed, authenticate never asked', async () => {
      authCalls = 0;
      const r = await send(port, 'PUT', ROUTE, json(100));
      assert.equal(r.status, 200);
      assert.equal(authCalls, 0);
    });
    await check('no credential: over the global limit -> rejected by the global parser', async () => {
      const r = await send(port, 'PUT', ROUTE, json(2000));
      assert.equal(r.status, 413);
      assert.equal(r.body.error, 'global');
      assert.equal(r.body.type, 'entity.too.large');
    });
    await check('wrong credential behaves like none', async () => {
      const r = await send(port, 'PUT', ROUTE, json(2000), { authorization: 'Bearer bad' });
      assert.equal(r.body.error, 'global');
    });
    await check('credential: over the global limit, within the big cap -> parsed', async () => {
      const r = await send(port, 'PUT', ROUTE, json(3000), { authorization: 'Bearer good' });
      assert.equal(r.status, 200);
      assert.equal(r.body.parsed, 1);
    });
    await check('credential: over the big cap -> JSON 413 with the editor limit', async () => {
      const r = await send(port, 'PUT', ROUTE, json(5000), { authorization: 'Bearer good' });
      assert.equal(r.status, 413);
      assert.equal(r.body.limit, EDITOR);
      assert.equal(typeof r.body.error, 'string');
      assert.match(r.body.message, /777/);
    });
    await check('no Content-Length (chunked): untouched, authenticate never asked, global limit applies', async () => {
      authCalls = 0;
      const r = await send(port, 'PUT', ROUTE, json(3000), { authorization: 'Bearer good' }, { chunked: true });
      assert.equal(r.body.error, 'global');
      assert.equal(authCalls, 0);
    });
    await check('other route / other method: the big limit does not apply even with a credential', async () => {
      for (const [method, p] of [['PUT', '/api/workspaces/abc/fs/mkdir'], ['POST', ROUTE], ['PUT', '/api/workspaces/abc/fs/file/x'], ['PUT', '/api/projects/1']]) {
        const r = await send(port, method, p, json(3000), { authorization: 'Bearer good' });
        assert.equal(r.body.error, 'global', `${method} ${p}`);
      }
    });
    await check('trailing slash still matches the route', async () => {
      const r = await send(port, 'PUT', `${ROUTE}/`, json(3000), { authorization: 'Bearer good' });
      assert.equal(r.status, 200);
    });
  } finally {
    server.close();
  }
  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
})();
