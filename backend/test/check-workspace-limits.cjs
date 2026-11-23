#!/usr/bin/env node
/*
 * Editor/download limits (SSH-Werkstatt, Task 3).
 *
 * - clampLimit: invalid -> default, above the ceiling -> ceiling, else floor.
 * - WorkspaceLimitsService reads both settings keys and clamps them.
 * - WorkspaceConfigController: GET shape, PUT validation (400 on non-number,
 *   < 1, above the ceiling), partial updates, only valid values are stored.
 * - WorkspaceClient forwards `maxBytes` to the sidecar (read, write, stream),
 *   and the download stream aborts after 60 s without data (idle, not absolute).
 *
 * Loads from dist/; run `npm run build` first. No database, no network.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { ReadableStream } = require('node:stream/web');

function load(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.\n${err.message}`);
    process.exit(2);
  }
}
const limits = load('workspaces/workspace-limits.service.js');
const { WorkspaceConfigController } = load('workspaces/workspace-config.controller.js');
const { WorkspaceClient } = load('workspaces/workspace-client.service.js');
const { clampLimit, clampRange, WorkspaceLimitsService } = limits;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`ok  ${label}`); }
  catch (err) { failures += 1; console.error(`FAIL ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function fakeSettings(initial = {}) {
  const store = { ...initial };
  return {
    store,
    get: async (k) => (k in store ? store[k] : null),
    set: async (k, v) => { store[k] = v; },
  };
}
async function badRequest(fn) {
  await assert.rejects(fn, (e) => e.getStatus && e.getStatus() === 400);
}

(async () => {
  await check('constants', () => {
    assert.equal(limits.EDITOR_DEFAULT_BYTES, 5 * MIB);
    assert.equal(limits.EDITOR_HARD_MAX_BYTES, 100 * MIB);
    assert.equal(limits.DOWNLOAD_DEFAULT_BYTES, 2 * GIB);
    assert.equal(limits.DOWNLOAD_HARD_MAX_BYTES, 50 * GIB);
  });

  await check('clampLimit', () => {
    assert.equal(clampLimit('abc', 5, 100), 5);
    assert.equal(clampLimit('0', 5, 100), 5);
    assert.equal(clampLimit('-3', 5, 100), 5);
    assert.equal(clampLimit('500', 5, 100), 100);
    assert.equal(clampLimit('42.9', 5, 100), 42);
    assert.equal(clampLimit(null, 5, 100), 5);
    assert.equal(clampLimit('', 5, 100), 5);
    assert.equal(clampLimit('Infinity', 5, 100), 5);
    assert.equal(clampLimit('0.5', 5, 100), 5);
    assert.equal(clampLimit('7', 5, 100), 7);
  });

  await check('service: defaults, stored values, clamping', async () => {
    assert.deepEqual(await new WorkspaceLimitsService(fakeSettings()).get(),
      { editorMaxBytes: 5 * MIB, downloadMaxBytes: 2 * GIB, terminalIdleMinutes: 30 });
    const s = fakeSettings({ 'workspaces.editorMaxBytes': String(8 * MIB), 'workspaces.downloadMaxBytes': String(999 * GIB), 'terminals.idleMinutes': '2' });
    assert.deepEqual(await new WorkspaceLimitsService(s).get(),
      { editorMaxBytes: 8 * MIB, downloadMaxBytes: 50 * GIB, terminalIdleMinutes: 5 });
  });

  await check('controller: GET shape', async () => {
    const ctrl = new WorkspaceConfigController(new WorkspaceLimitsService(fakeSettings()), fakeSettings());
    assert.deepEqual(await ctrl.getConfig(), {
      editorMaxBytes: 5 * MIB, downloadMaxBytes: 2 * GIB,
      editorDefaultBytes: 5 * MIB, editorHardMaxBytes: 100 * MIB,
      downloadDefaultBytes: 2 * GIB, downloadHardMaxBytes: 50 * GIB,
      terminalIdleMinutes: 30, terminalIdleDefaultMinutes: 30,
      terminalIdleMinMinutes: 5, terminalIdleMaxMinutes: 1440,
    });
  });

  await check('terminal idle: constants, clampRange, service', async () => {
    assert.equal(limits.TERMINAL_IDLE_KEY, 'terminals.idleMinutes');
    assert.equal(limits.TERMINAL_IDLE_DEFAULT_MINUTES, 30);
    assert.equal(limits.TERMINAL_IDLE_MIN_MINUTES, 5);
    assert.equal(limits.TERMINAL_IDLE_MAX_MINUTES, 1440);
    assert.equal(clampRange(null, 30, 5, 1440), 30);
    assert.equal(clampRange('', 30, 5, 1440), 30);
    assert.equal(clampRange('abc', 30, 5, 1440), 30);
    assert.equal(clampRange('Infinity', 30, 5, 1440), 30);
    assert.equal(clampRange('1', 30, 5, 1440), 5);
    assert.equal(clampRange('-7', 30, 5, 1440), 5);
    assert.equal(clampRange('99999', 30, 5, 1440), 1440);
    assert.equal(clampRange('45.8', 30, 5, 1440), 45);
    const svc = new WorkspaceLimitsService(fakeSettings({ 'terminals.idleMinutes': '60' }));
    assert.equal(await svc.terminalIdleMs(), 60 * 60_000);
    assert.equal(await new WorkspaceLimitsService(fakeSettings()).terminalIdleMs(), 30 * 60_000);
  });

  await check('terminal idle: PUT validates the range', async () => {
    const settings = fakeSettings();
    const ctrl = new WorkspaceConfigController(new WorkspaceLimitsService(settings), settings);
    for (const bad of [{ terminalIdleMinutes: 4 }, { terminalIdleMinutes: 1441 }, { terminalIdleMinutes: 'x' },
      { terminalIdleMinutes: NaN }, { terminalIdleMinutes: null }, { terminalIdleMinutes: 30, editorMaxBytes: 0 }]) {
      await badRequest(() => ctrl.setConfig(bad));
    }
    assert.deepEqual(settings.store, {});
    const res = await ctrl.setConfig({ terminalIdleMinutes: 90 });
    assert.equal(res.terminalIdleMinutes, 90);
    assert.equal(settings.store['terminals.idleMinutes'], '90');
    assert.equal('workspaces.editorMaxBytes' in settings.store, false);
    assert.equal((await ctrl.setConfig({ terminalIdleMinutes: 5 })).terminalIdleMinutes, 5);
    assert.equal((await ctrl.setConfig({ terminalIdleMinutes: 1440 })).terminalIdleMinutes, 1440);
  });

  await check('controller: PUT validates and stores only valid values', async () => {
    const settings = fakeSettings();
    const ctrl = new WorkspaceConfigController(new WorkspaceLimitsService(settings), settings);
    for (const bad of [{ editorMaxBytes: 'x' }, { editorMaxBytes: 0 }, { editorMaxBytes: -1 },
      { editorMaxBytes: 100 * MIB + 1 }, { downloadMaxBytes: 50 * GIB + 1 }, { downloadMaxBytes: NaN },
      { editorMaxBytes: null }, {}, null, undefined]) {
      await badRequest(() => ctrl.setConfig(bad));
    }
    assert.deepEqual(settings.store, {});
    const res = await ctrl.setConfig({ editorMaxBytes: 8 * MIB + 0.7 });
    assert.equal(res.editorMaxBytes, 8 * MIB);
    assert.equal(res.downloadMaxBytes, 2 * GIB);
    assert.equal(settings.store['workspaces.editorMaxBytes'], String(8 * MIB));
    assert.equal('workspaces.downloadMaxBytes' in settings.store, false);
    const both = await ctrl.setConfig({ editorMaxBytes: 100 * MIB, downloadMaxBytes: 50 * GIB });
    assert.equal(both.downloadMaxBytes, 50 * GIB);
  });

  await check('client: maxBytes reaches the sidecar (read, write, readStream)', async () => {
    process.env.WORKSPACE_API_TOKEN = 'test-token-0123456789';
    const posts = [];
    const http = { post: (url, body) => ({ subscribe: (o) => { posts.push({ url, body }); o.next({ data: { size: 1, content: 'x', hash: 'h' } }); o.complete(); } }) };
    const client = new WorkspaceClient(http);
    await client.readText('w', 'a', 8 * MIB);
    await client.readText('w', 'a');
    await client.writeText('w', 'a', 'x', { baseHash: null, maxBytes: 9 * MIB });
    assert.equal(posts[0].body.maxBytes, 8 * MIB);
    assert.equal(posts[1].body.maxBytes, undefined);
    assert.equal(posts[2].body.maxBytes, 9 * MIB);
    const orig = global.fetch;
    let sent;
    global.fetch = async (_u, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, headers: { get: () => '3' }, body: Readable.toWeb(Readable.from([Buffer.from('abc')])) };
    };
    try {
      const { stream } = await client.readStream('w', 'f', { maxBytes: 3 * GIB });
      for await (const _c of stream) { /* drain */ }
    } finally { global.fetch = orig; }
    assert.equal(sent.maxBytes, 3 * GIB);
  });

  await check('client: 413 from the sidecar keeps limit in the forwarded body', async () => {
    process.env.WORKSPACE_API_TOKEN = 'test-token-0123456789';
    const client = new WorkspaceClient({});
    const orig = global.fetch;
    global.fetch = async () => ({
      ok: false, status: 413, statusText: 'Payload Too Large',
      text: async () => JSON.stringify({ error: 'file too large (>5 bytes)', size: 9, limit: 5 }),
    });
    try {
      await assert.rejects(() => client.readStream('w', 'f', { httpErrors: true, maxBytes: 5 }), (e) => {
        const b = e.getResponse();
        return e.getStatus() === 413 && b.limit === 5 && b.message === 'file too large (>5 bytes)' && typeof b.error === 'string';
      });
    } finally { global.fetch = orig; }
  });

  await check('client: download stream dies after an idle period, not an absolute one', async () => {
    process.env.WORKSPACE_API_TOKEN = 'test-token-0123456789';
    const client = new WorkspaceClient({});
    const orig = global.fetch;
    let aborted = false;
    global.fetch = async (_u, init) => {
      init.signal.addEventListener('abort', () => { aborted = true; });
      // First chunk immediately, then silence.
      const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } });
      return { ok: true, headers: { get: () => '10' }, body };
    };
    const realSetTimeout = global.setTimeout;
    const timers = [];
    global.setTimeout = (fn, ms, ...a) => { const t = realSetTimeout(fn, 0, ...a); timers.push(ms); return t; };
    try {
      const { stream } = await client.readStream('w', 'f');
      await assert.rejects(async () => { for await (const _c of stream) { /* wait */ } }, /idle/);
    } finally { global.setTimeout = realSetTimeout; global.fetch = orig; }
    assert.ok(timers.includes(60_000), `idle timer 60 s expected, got ${timers.join(',')}`);
    assert.equal(aborted, true);
  });

  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
})();
