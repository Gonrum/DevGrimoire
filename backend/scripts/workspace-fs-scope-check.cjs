#!/usr/bin/env node
/*
 * Workspace IDE REST routes (`/workspaces/:id/fs/*`).
 *
 * Pinned here:
 *   - every route, GETs included, is gated: permission allowlist without
 *     project:write/customer:write -> 403, project out of scope -> 403,
 *     workspace archived/cleaning -> 409; the sidecar client is never reached
 *   - sidecar errors keep status AND body (409 currentHash)
 *   - PUT file DTO: baseHash must be string | null, never undefined
 *   - tree ordering, upload noOverwrite / fileName validation, search flags
 *   - status without a git repo, parseRipgrepJson / parseGitStatus
 *   - touchThrottled, and no @McpToolEquivalent mapping on any handler
 *
 * Loads from dist/; run `npm run build` first.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { Readable, PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { WorkspaceFsController } = loadCompiled('workspaces/workspace-fs.controller.js');
const { WorkspacesService } = loadCompiled('workspaces/workspaces.service.js');
const { parseRipgrepJson, parseGitStatus } = loadCompiled('workspaces/workspace-search-parse.js');
const dtos = loadCompiled('workspaces/dto/workspace-fs.dto.js');
const { RequestContext } = loadCompiled('common/request-context.js');
const { MCP_TOOL_EQUIVALENT_KEY } = loadCompiled('auth/decorators/mcp-tool-equivalent.decorator.js');
const { HttpException } = require(path.resolve(__dirname, '..', 'node_modules', '@nestjs/common'));
const { validate } = require(path.resolve(__dirname, '..', 'node_modules', 'class-validator'));
const { plainToInstance } = require(path.resolve(__dirname, '..', 'node_modules', 'class-transformer'));
const http = require('node:http');
const { throwError, of } = require(path.resolve(__dirname, '..', 'node_modules', 'rxjs'));
const { AxiosError } = require(path.resolve(__dirname, '..', 'node_modules', 'axios'));
const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const EXPECTED_CHECKS = 21;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const statusOf = (e) => (typeof e.getStatus === 'function' ? e.getStatus() : e.status);
const oid = () => new mongoose.Types.ObjectId();
const PROJECT = oid();
const WS_ID = oid().toString();

const ADMIN = { userId: 'u1', username: 'u', role: 'admin' };
const READ_ONLY = { ...ADMIN, permissions: ['project:read', 'todo:read'], permissionsRestricted: true };
const WRITER = { ...ADMIN, permissions: ['project:write'], permissionsRestricted: true };
const OTHER_PROJECT_ONLY = { ...ADMIN, projectScopeMode: 'allowlist', allowedProjectIds: [oid().toString()] };

function setup({ status = 'active', client = {} } = {}) {
  const calls = [];
  const rec = (name, result) => async (...args) => {
    calls.push({ name, args });
    const r = typeof result === 'function' ? result(...args) : result;
    if (r instanceof Error) throw r;
    return r;
  };
  const fakeClient = {
    readText: rec('readText', { size: 3, content: 'abc', hash: 'h1' }),
    writeText: rec('writeText', { path: 'a.txt', hash: 'h2', size: 3 }),
    listDir: rec('listDir', { root: '.', depth: 1, truncated: false, entries: [] }),
    mkdir: rec('mkdir', (p) => ({ ok: true, path: p })),
    move: rec('move', (f, t) => ({ ok: true, from: f, to: t })),
    remove: rec('remove', {}),
    readStream: rec('readStream', () => ({ stream: Readable.from([Buffer.from('xyz')]), size: 3 })),
    writeStream: rec('writeStream', async (ws, p, source, opts) => {
      for await (const _c of source) { /* drain */ }
      return { ok: true, path: `${p}${opts.fileName}`, size: 3 };
    }),
    searchJson: rec('searchJson', { matches: '', truncated: false, timedOut: false }),
    statusFs: rec('statusFs', { status: '## main\n' }),
    ...client,
  };
  const touches = { n: 0 };
  const workspace = { _id: oid(), projectId: PROJECT, status };
  const service = new WorkspacesService(
    {
      findById: () => ({ exec: async () => workspace }),
      updateOne: () => ({ exec: async () => { touches.n += 1; } }),
    },
    { emit() {} },
  );
  const logged = [];
  const ctrl = new WorkspaceFsController(service, fakeClient, { create: async (d) => { logged.push(d); } });
  return { ctrl, calls, touches, logged, service };
}

const fakeRes = () => Object.assign(new PassThrough(), {
  headers: {}, setHeader(k, v) { this.headers[k] = v; },
});
const fakeUpload = (headers = { 'content-length': '3' }) =>
  Object.assign(Readable.from([Buffer.from('abc')]), { headers });
const fakeUploadRes = () => Object.assign(new EventEmitter(), { writableFinished: false });

// Every route as a closure over (ctrl).
const ROUTES = {
  'GET tree': (c) => c.tree(WS_ID, 'src'),
  'GET file': (c) => c.readFile(WS_ID, 'a.txt'),
  'GET raw': (c) => c.raw(WS_ID, fakeRes(), 'a.txt'),
  'PUT file': (c) => c.writeFile(WS_ID, { path: 'a.txt', content: 'x', baseHash: null }),
  'POST mkdir': (c) => c.mkdir(WS_ID, { path: 'd' }),
  'POST move': (c) => c.move(WS_ID, { from: 'a', to: 'b' }),
  'POST delete': (c) => c.remove(WS_ID, { path: 'a' }),
  'POST upload': (c) => c.upload(WS_ID, fakeUpload(), fakeUploadRes(), '.', 'f.bin', undefined),
  'POST search': (c) => c.search(WS_ID, { query: 'x' }),
  'GET status': (c) => c.status(WS_ID),
};

async function expectDenied(label, actor, opts, wanted) {
  for (const [name, run] of Object.entries(ROUTES)) {
    const { ctrl, calls } = setup(opts);
    await assert.rejects(
      () => RequestContext.run(actor, undefined, () => run(ctrl)),
      (e) => statusOf(e) === wanted,
      `${label}: ${name} must answer ${wanted}`,
    );
    assert.equal(calls.length, 0, `${label}: ${name} must not reach the sidecar client`);
  }
}

const ndjson = (...objs) => objs.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n');
const matchLine = (p, line, text, start = 4) => ({
  type: 'match',
  data: { path: { text: p }, lines: { text }, line_number: line, submatches: [{ start, end: start + 1 }] },
});

(async () => {
  await check('parseRipgrepJson: match mapped, ./ stripped, noise skipped, 1-based column', () => {
    const out = parseRipgrepJson(ndjson(
      { type: 'begin', data: { path: { text: 'src/a.ts' } } },
      matchLine('src/a.ts', 3, '  const x\n'),
      'garbage {{',
      matchLine('./b.ts', 1, 'y'.repeat(400) + '\r\n', 0),
      { type: 'end', data: {} },
      { type: 'summary', data: {} },
    ), 10);
    assert.deepEqual(out.matches[0], { path: 'src/a.ts', line: 3, column: 5, text: '  const x' });
    assert.equal(out.matches[1].path, 'b.ts');
    assert.equal(out.matches[1].column, 1);
    assert.equal(out.matches[1].text.length, 300);
    assert.equal(out.matches.length, 2);
    assert.equal(out.truncated, false);
  });

  await check('parseRipgrepJson: limit 2 on 3 matches -> 2 matches, truncated', () => {
    const out = parseRipgrepJson(ndjson(matchLine('a', 1, 'x'), matchLine('a', 2, 'x'), matchLine('a', 3, 'x')), 2);
    assert.equal(out.matches.length, 2);
    assert.equal(out.truncated, true);
  });

  await check('parseGitStatus: branch header and porcelain entries', () => {
    const out = parseGitStatus('## main...origin/main [ahead 1]\n M src/a.ts\n?? new file.txt\nR  old.ts -> new.ts\n');
    assert.equal(out.branch, 'main');
    assert.deepEqual(out.changed, [
      { path: 'src/a.ts', code: ' M' },
      { path: 'new file.txt', code: '??' },
      { path: 'new.ts', code: 'R ' },
    ]);
    assert.equal(parseGitStatus('## No commits yet on dev\n').branch, 'dev');
  });

  await check('every route (GET included): allowlist without project:write/customer:write -> 403, client untouched', async () => {
    await expectDenied('read-only actor', READ_ONLY, {}, 403);
  });

  await check('every route: project outside the actor scope -> 403, client untouched', async () => {
    await expectDenied('foreign project', OTHER_PROJECT_ONLY, {}, 403);
  });

  await check('every route: workspace archived or cleaning -> 409, client untouched', async () => {
    await expectDenied('archived', WRITER, { status: 'archived' }, 409);
    await expectDenied('cleaning', WRITER, { status: 'cleaning' }, 409);
  });

  await check('actor with project:write passes the gate on every route', async () => {
    for (const [name, run] of Object.entries(ROUTES)) {
      const { ctrl, calls } = setup();
      await RequestContext.run(WRITER, undefined, () => run(ctrl));
      assert.ok(calls.length >= 1, `${name} should reach the client`);
    }
  });

  await check('PUT file: sidecar 409 keeps status and currentHash body', async () => {
    const conflict = new HttpException({ error: 'conflict', currentHash: 'abc' }, 409);
    const { ctrl } = setup({ client: { writeText: async () => { throw conflict; } } });
    await assert.rejects(
      () => RequestContext.run(WRITER, undefined, () => ctrl.writeFile(WS_ID, { path: 'a', content: 'x', baseHash: 'old' })),
      (e) => statusOf(e) === 409 && e.getResponse().currentHash === 'abc',
    );
  });

  await check('PUT file DTO: baseHash must be string or null, undefined -> invalid', async () => {
    const errorsFor = async (body) => (await validate(plainToInstance(dtos.FsWriteDto, body))).length;
    assert.equal(await errorsFor({ path: 'a', content: 'x' }), 1, 'missing baseHash');
    assert.equal(await errorsFor({ path: 'a', content: 'x', baseHash: undefined }), 1);
    assert.equal(await errorsFor({ path: 'a', content: 'x', baseHash: 5 }), 1);
    assert.equal(await errorsFor({ path: 'a', content: 'x', baseHash: null }), 0);
    assert.equal(await errorsFor({ path: 'a', content: 'x', baseHash: 'deadbeef' }), 0);
  });

  await check('DTOs: path rules (absolute, NUL, empty, too long), search limits', async () => {
    const bad = async (Dto, body) => (await validate(plainToInstance(Dto, body))).length > 0;
    for (const p of ['/etc/passwd', 'a\0b', '', 'x'.repeat(4097), 5]) {
      assert.equal(await bad(dtos.FsPathDto, { path: p }), true, `path ${JSON.stringify(p).slice(0, 20)}`);
    }
    assert.equal(await bad(dtos.FsPathDto, { path: 'sp ace/#x?y' }), false);
    assert.equal(await bad(dtos.FsMoveDto, { from: 'a', to: '/abs' }), true);
    assert.equal(await bad(dtos.FsSearchDto, { query: 'q'.repeat(501) }), true);
    assert.equal(await bad(dtos.FsSearchDto, { query: 'q', include: Array(21).fill('*.ts') }), true);
    assert.equal(await bad(dtos.FsSearchDto, { query: 'q', exclude: ['x'.repeat(201)] }), true);
    assert.equal(await bad(dtos.FsSearchDto, { query: 'q', include: ['*.ts'], exclude: ['dist'] }), false);
  });

  await check('GET tree: dirs first, then by name; truncated passed through; odd names intact', async () => {
    const { ctrl, calls } = setup({ client: { listDir: async () => ({
      root: 'src', depth: 1, truncated: true, entries: [
        { path: 'src/b.ts', type: 'file', size: 10 },
        { path: 'src/z dir', type: 'dir' },
        { path: 'src/#hash?.md', type: 'file', size: 1 },
        { path: 'src/a dir', type: 'dir' },
        { path: 'src/link', type: 'symlink' },
      ],
    }) } });
    const out = await RequestContext.run(WRITER, undefined, () => ctrl.tree(WS_ID, 'src'));
    assert.deepEqual(out.entries.map((e) => e.name), ['a dir', 'z dir', '#hash?.md', 'b.ts', 'link']);
    assert.equal(out.truncated, true);
    assert.equal(out.entries[3].size, 10);
    assert.equal('size' in out.entries[0], false);
    assert.equal(out.entries[2].path, 'src/#hash?.md');
    assert.equal(calls.length, 0, 'sanity: custom client bypasses recorder');
  });

  await check('query paths: default ".", invalid values -> 400', async () => {
    const { ctrl, calls } = setup();
    await RequestContext.run(WRITER, undefined, () => ctrl.tree(WS_ID, undefined));
    assert.equal(calls[0].args[1], '.');
    for (const bad of ['/abs', 'a\0b', '']) {
      await assert.rejects(
        () => RequestContext.run(WRITER, undefined, () => ctrl.readFile(WS_ID, bad)),
        (e) => statusOf(e) === 400,
      );
    }
    await assert.rejects(
      () => RequestContext.run(WRITER, undefined, () => ctrl.readFile(WS_ID, undefined)),
      (e) => statusOf(e) === 400,
    );
  });

  await check('GET raw: octet-stream + attachment, bytes piped', async () => {
    const { ctrl } = setup();
    const res = fakeRes();
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    const done = new Promise((r) => res.on('end', r));
    await RequestContext.run(WRITER, undefined, () => ctrl.raw(WS_ID, res, 'dir/na"me.bin'));
    await done;
    assert.equal(res.headers['Content-Type'], 'application/octet-stream');
    assert.match(res.headers['Content-Disposition'], /^attachment; filename="na_me\.bin"/);
    assert.equal(Buffer.concat(chunks).toString(), 'xyz');
  });

  await check('POST upload: noOverwrite unless overwrite=1; streams req unbuffered; audit entry', async () => {
    const { ctrl, calls, logged } = setup();
    const req = fakeUpload();
    const out = await RequestContext.run(WRITER, undefined, () =>
      ctrl.upload(WS_ID, req, fakeUploadRes(), 'sub/dir/', 'a.bin', undefined));
    assert.equal(calls[0].args[2], req, 'the request stream itself is handed on');
    assert.deepEqual(calls[0].args[3], { fileName: 'a.bin', size: 3, noOverwrite: true, httpErrors: true });
    assert.equal(calls[0].args[1], 'sub/dir/');
    assert.deepEqual(out, { path: 'sub/dir/a.bin', size: 3 });
    await RequestContext.run(WRITER, undefined, () =>
      ctrl.upload(WS_ID, fakeUpload({}), fakeUploadRes(), undefined, 'a.bin', '1'));
    assert.equal(calls[1].args[3].noOverwrite, false);
    assert.equal(calls[1].args[3].size, undefined);
    assert.equal(calls[1].args[1], './');
    await new Promise((r) => setImmediate(r));
    assert.equal(logged.length, 2);
    assert.deepEqual([logged[0].service, logged[0].area, logged[0].tags[0]], ['workspaces', 'ide', 'workspace_ide']);
  });

  await check('POST upload: target exists -> 409; fileName a/b, .., empty -> 400', async () => {
    const { ctrl } = setup({ client: { writeStream: async () => { throw new HttpException('target exists', 409); } } });
    await assert.rejects(
      () => RequestContext.run(WRITER, undefined, () => ctrl.upload(WS_ID, fakeUpload(), fakeUploadRes(), '.', 'x', undefined)),
      (e) => statusOf(e) === 409,
    );
    for (const name of ['a/b', '..', '.', '', undefined, 'a\\b']) {
      const s = setup();
      await assert.rejects(
        () => RequestContext.run(WRITER, undefined, () => s.ctrl.upload(WS_ID, fakeUpload(), fakeUploadRes(), '.', name, undefined)),
        (e) => statusOf(e) === 400,
      );
      assert.equal(s.calls.length, 0);
    }
  });

  await check('POST search: regex absent -> fixedStrings, regex:true -> not; matches parsed', async () => {
    const { ctrl, calls } = setup({ client: { searchJson: async (ws, q) => {
      calls.push(q);
      return { matches: ndjson(matchLine('./s.ts', 2, 'hit\n')), truncated: false, timedOut: false };
    } } });
    const a = await RequestContext.run(WRITER, undefined, () => ctrl.search(WS_ID, { query: 'q' }));
    await RequestContext.run(WRITER, undefined, () => ctrl.search(WS_ID, { query: 'q', regex: true, caseSensitive: true }));
    assert.deepEqual([calls[0].fixedStrings, calls[0].caseSensitive], [true, false]);
    assert.deepEqual([calls[1].fixedStrings, calls[1].caseSensitive], [false, true]);
    assert.deepEqual(a, { matches: [{ path: 's.ts', line: 2, column: 5, text: 'hit' }], truncated: false });
  });

  await check('GET status: no repo (sidecar 409) -> empty; porcelain parsed otherwise', async () => {
    const none = setup({ client: { statusFs: async () => { throw new HttpException({ error: 'no git repo' }, 409); } } });
    assert.deepEqual(await RequestContext.run(WRITER, undefined, () => none.ctrl.status(WS_ID)), { branch: null, changed: [] });
    const ok = setup({ client: { statusFs: async () => ({ status: '## main...origin/main\n M src/a.ts\n' }) } });
    assert.deepEqual(await RequestContext.run(WRITER, undefined, () => ok.ctrl.status(WS_ID)),
      { branch: 'main', changed: [{ path: 'src/a.ts', code: ' M' }] });
    const boom = setup({ client: { statusFs: async () => { throw new HttpException('x', 413); } } });
    await assert.rejects(() => RequestContext.run(WRITER, undefined, () => boom.ctrl.status(WS_ID)), (e) => statusOf(e) === 413);
  });

  await check('WorkspaceClient: sidecar 400/404/409/413/415 keep status and body on the new methods; 500 does not', async () => {
    process.env.WORKSPACE_API_TOKEN = 'tok';
    const { WorkspaceClient } = loadCompiled('workspaces/workspace-client.service.js');
    const failWith = (status, data) => new WorkspaceClient({
      post: () => throwError(() => new AxiosError('x', 'ERR', undefined, undefined, { status, statusText: 's', data, headers: {}, config: {} })),
    });
    for (const status of [400, 404, 409, 413, 415]) {
      const body = { error: 'e', currentHash: 'h', size: 7 };
      await assert.rejects(
        () => failWith(status, body).writeText('w', 'a', 'x', { baseHash: null }),
        (e) => e instanceof HttpException && statusOf(e) === status && e.getResponse().currentHash === 'h',
      );
    }
    await assert.rejects(
      () => failWith(500, { error: 'boom' }).readText('w', 'a'),
      (e) => !(e instanceof HttpException) && /sidecar 500/.test(e.message),
    );
    // Old callers keep the plain Error for a 409.
    await assert.rejects(() => failWith(409, { error: 'x' }).read('w', 'a'), (e) => !(e instanceof HttpException));
    // baseHash is always on the wire, null included.
    let sent;
    const spy = new WorkspaceClient({ post: (_u, body) => { sent = body; return of({ data: { path: 'a', hash: 'h', size: 1 } }); } });
    await spy.writeText('w', 'a', 'x', { baseHash: null });
    assert.equal(sent.baseHash, null);
    assert.equal(Object.prototype.hasOwnProperty.call(sent, 'baseHash'), true);
    // writeStream: noOverwrite turns the sidecar 409 into a ConflictException.
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'target exists' }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.WORKSPACE_API_URL = `http://127.0.0.1:${server.address().port}`;
    try {
      const c = new WorkspaceClient({});
      await assert.rejects(
        () => c.writeStream('w', './', Readable.from([Buffer.from('a')]), { fileName: 'f', noOverwrite: true }),
        (e) => statusOf(e) === 409,
      );
      await assert.rejects(
        () => c.writeStream('w', './', Readable.from([Buffer.from('a')]), { fileName: 'f' }),
        (e) => !(e instanceof HttpException) && /sidecar 409/.test(e.message),
      );
    } finally { server.close(); }
  });

  await check('upload through a real HTTP server: sidecar 409/413 reach the browser as status + body, even for a 32 MB body', async () => {
    process.env.WORKSPACE_API_TOKEN = 'tok';
    const { WorkspaceClient } = loadCompiled('workspaces/workspace-client.service.js');
    let sidecarStatus = 409;
    const sidecar = http.createServer((req, res) => {
      // Answers at once, without reading the body (like the early 409).
      res.writeHead(sidecarStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: sidecarStatus === 409 ? 'target exists' : 'too large' }));
    });
    await new Promise((r) => sidecar.listen(0, '127.0.0.1', r));
    process.env.WORKSPACE_API_URL = `http://127.0.0.1:${sidecar.address().port}`;
    const client = new WorkspaceClient({});
    const front = http.createServer(async (req, res) => {
      try {
        await client.writeStream('w', './', req, { fileName: 'f', size: Number(req.headers['content-length']), noOverwrite: true, httpErrors: true });
        res.writeHead(200).end('{}');
      } catch (e) {
        res.writeHead(statusOf(e) || 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify(e.getResponse ? e.getResponse() : { error: e.message }));
      }
    });
    await new Promise((r) => front.listen(0, '127.0.0.1', r));
    try {
      for (const [status, error] of [[409, 'target exists'], [413, 'too large']]) {
        sidecarStatus = status;
        const r = await fetch(`http://127.0.0.1:${front.address().port}/`, {
          method: 'POST', body: Buffer.alloc(32 * 1024 * 1024, 1),
          headers: { 'content-type': 'application/octet-stream' },
        });
        assert.equal(r.status, status);
        assert.equal((await r.json()).error, error);
      }
    } finally { front.close(); sidecar.close(); }
  });

  await check('touchThrottled: two calls within the window -> touch once; swallows errors', async () => {
    const { service, touches } = setup();
    service.touchThrottled(WS_ID);
    service.touchThrottled(WS_ID);
    await new Promise((r) => setImmediate(r));
    assert.equal(touches.n, 1);
    const failing = new WorkspacesService({ updateOne: () => ({ exec: async () => { throw new Error('db down'); } }) }, { emit() {} });
    failing.touchThrottled('x');
    await new Promise((r) => setImmediate(r));
  });

  await check('no handler of WorkspaceFsController carries McpToolEquivalent metadata', () => {
    const names = Object.getOwnPropertyNames(WorkspaceFsController.prototype).filter((n) => n !== 'constructor' && !n.startsWith('gate') && n !== 'audit');
    assert.ok(names.length >= 10);
    for (const n of names) {
      assert.equal(Reflect.getMetadata(MCP_TOOL_EQUIVALENT_KEY, WorkspaceFsController.prototype[n]), undefined, n);
    }
  });

  console.log(`\n${total - failures}/${total} passed`);
  if (total !== EXPECTED_CHECKS) {
    console.error(`Expected ${EXPECTED_CHECKS} checks, ran ${total}`);
    process.exit(1);
  }
  process.exit(failures === 0 ? 0 : 1);
})();
