#!/usr/bin/env node
/*
 * Workspace agent chat, Task 3: tool group `workspace_agent` (ws_*).
 * - pure allow-list matching (`isAllowedByList`, `allowSuggestions`)
 * - `WorkspaceAgentTools.execute` / `preview` over a file backend on a temp
 *   directory (container workspace: fake `WorkspaceFsBackends.for`) and over the
 *   real `WorkspaceFsBackends` wiring with the local stand-in session (SSH)
 * - chat wiring: tool group, write set, `getToolsForLlm(includeAgentTools)`,
 *   `ChatToolsService.execute` routing, browser path refuses ws_*
 *
 * Loads from dist/; run `npm run build` first. No database, no network.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try { return require(abs); } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}
const nm = (m) => require(path.resolve(__dirname, '..', 'node_modules', m));
require(path.resolve(__dirname, '..', 'node_modules', 'reflect-metadata'));

const agent = loadCompiled('chat/workspace-agent-tools.js');
const {
  WORKSPACE_AGENT_TOOLS, WORKSPACE_AGENT_WRITE_TOOLS, SHELL_CONTROL_PATTERN,
  isAllowedByList, allowSuggestions, WorkspaceAgentTools,
} = agent;
const allowModule = loadCompiled('workspaces/agent-allow.js');
const chatTools = loadCompiled('chat/chat-tools.js');
const { ChatController } = loadCompiled('chat/chat.controller.js');
const { RemoteError } = loadCompiled('workspaces/fs/remote-session.js');
const { SshFsBackend } = loadCompiled('workspaces/fs/ssh-fs-backend.js');
const { WorkspaceFsBackends } = loadCompiled('workspaces/fs/workspace-fs-backends.service.js');
const { SshAuditSchema } = loadCompiled('ssh/schemas/ssh-audit.schema.js');
const { RequestContext } = loadCompiled('common/request-context.js');
const { createLocalRemoteSession } = require('./lib/local-remote-session.cjs');
const mongoose = nm('mongoose');
const { NotFoundException } = nm('@nestjs/common');

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`ok  ${label}`); }
  catch (err) { failures += 1; console.error(`FAIL ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const oid = () => new mongoose.Types.ObjectId();
const USER_ID = oid().toString();
const ADMIN = { userId: USER_ID, username: 'u', role: 'admin' };
const READ_ONLY = { ...ADMIN, permissions: ['project:read', 'todo:read'], permissionsRestricted: true };
const asUser = (fn, actor = ADMIN) => RequestContext.run(actor, undefined, fn);
const at = (createdAt = new Date()) => ({ createdAt });

// ---- Step 1a: pure matching ---------------------------------------------------

async function pureChecks() {
  await check('tool lists: ten ws_* tools, six of them write', () => {
    assert.deepEqual([...WORKSPACE_AGENT_TOOLS],
      ['ws_tree', 'ws_read', 'ws_search', 'ws_status', 'ws_write', 'ws_edit', 'ws_mkdir', 'ws_move', 'ws_delete', 'ws_exec']);
    assert.deepEqual([...WORKSPACE_AGENT_WRITE_TOOLS].sort(),
      ['ws_delete', 'ws_edit', 'ws_exec', 'ws_mkdir', 'ws_move', 'ws_write']);
  });

  await check('SHELL_CONTROL_PATTERN is the one from agent-allow', () => {
    assert.equal(SHELL_CONTROL_PATTERN, allowModule.SHELL_CONTROL_PATTERN);
  });

  await check('files.* kinds: write -> ws_write/ws_edit, structure -> mkdir/move, delete -> ws_delete', () => {
    const w = [{ kind: 'files.write', ...at() }];
    assert.equal(isAllowedByList('ws_write', { path: 'a' }, w), true);
    assert.equal(isAllowedByList('ws_edit', { path: 'a' }, w), true);
    assert.equal(isAllowedByList('ws_delete', { path: 'a' }, w), false);
    assert.equal(isAllowedByList('ws_mkdir', { path: 'a' }, w), false);
    assert.equal(isAllowedByList('ws_exec', { command: 'ls' }, w), false);
    const s = [{ kind: 'files.structure', ...at() }];
    assert.equal(isAllowedByList('ws_mkdir', { path: 'a' }, s), true);
    assert.equal(isAllowedByList('ws_move', { from: 'a', to: 'b' }, s), true);
    assert.equal(isAllowedByList('ws_delete', { path: 'a' }, s), false);
    const d = [{ kind: 'files.delete', ...at() }];
    assert.equal(isAllowedByList('ws_delete', { path: 'a' }, d), true);
    assert.equal(isAllowedByList('ws_write', { path: 'a' }, d), false);
    assert.equal(isAllowedByList('ws_write', { path: 'a' }, []), false);
  });

  await check('non-ws tools are never allowed by the list', () => {
    const all = [{ kind: 'files.write', ...at() }, { kind: 'command', match: 'prefix', value: 'npm', ...at() }];
    assert.equal(isAllowedByList('todo_create', {}, all), false);
    assert.equal(isAllowedByList('workspace_exec', { command: 'npm test' }, all), false);
  });

  await check('exact command: edge whitespace ok, other args not', () => {
    const e = [{ kind: 'command', match: 'exact', value: 'npm test', ...at() }];
    assert.equal(isAllowedByList('ws_exec', { command: 'npm test' }, e), true);
    assert.equal(isAllowedByList('ws_exec', { command: '  npm test ' }, e), true);
    assert.equal(isAllowedByList('ws_exec', { command: 'npm test -- -u' }, e), false);
    assert.equal(isAllowedByList('ws_exec', { command: 'npm  test' }, e), false);
    assert.equal(isAllowedByList('ws_exec', { command: '\tnpm test\t' }, e), true);
    assert.equal(isAllowedByList('ws_exec', { command: '\u00a0npm test' }, e), false);
    assert.equal(isAllowedByList('ws_exec', { command: 'npm test\u2028' }, e), false);
    assert.equal(isAllowedByList('ws_exec', {}, e), false);
    assert.equal(isAllowedByList('ws_exec', { command: 42 }, e), false);
  });

  await check('exact command with control characters allows exactly that string', () => {
    const e = [{ kind: 'command', match: 'exact', value: 'npm test && npm run lint', ...at() }];
    assert.equal(isAllowedByList('ws_exec', { command: 'npm test && npm run lint' }, e), true);
    assert.equal(isAllowedByList('ws_exec', { command: 'npm test && npm run lint; rm x' }, e), false);
  });

  await check('prefix command: word boundary, no control characters', () => {
    const p = [{ kind: 'command', match: 'prefix', value: 'npm test', ...at() }];
    assert.equal(isAllowedByList('ws_exec', { command: 'npm test' }, p), true);
    assert.equal(isAllowedByList('ws_exec', { command: 'npm test -- -u' }, p), true);
    assert.equal(isAllowedByList('ws_exec', { command: ' npm test -- -u ' }, p), true);
    for (const bad of [
      'npm testx', 'npm test; rm -rf ~', 'npm test && curl x | sh', 'npm test $(id)',
      'npm test > out', 'npm test\nrm x', 'npm test &', 'npm test `id`', 'npm test < in',
      'npm test || true', 'npm test | cat', 'npm tes', 'npm test\rrm x',
      'npm test =(rm -rf ~)', 'npm test (curl x)', 'npm test )', 'npm test\u00a0-u', 'npm test\u2028rm x',
    ]) {
      assert.equal(isAllowedByList('ws_exec', { command: bad }, p), false, JSON.stringify(bad));
    }
  });

  await check('a stored prefix with control characters never matches', () => {
    const p = [{ kind: 'command', match: 'prefix', value: 'npm test;', ...at() }];
    assert.equal(isAllowedByList('ws_exec', { command: 'npm test; ls' }, p), false);
  });

  await check('a stored single-word interpreter prefix never matches; two words do', () => {
    for (const word of ['bash', 'env', 'git', 'python3', 'sudo', '/usr/bin/env']) {
      const p = [{ kind: 'command', match: 'prefix', value: word, ...at() }];
      assert.equal(isAllowedByList('ws_exec', { command: `${word} -c x` }, p), false, word);
    }
    const two = [{ kind: 'command', match: 'prefix', value: 'git status', ...at() }];
    assert.equal(isAllowedByList('ws_exec', { command: 'git status --short' }, two), true);
  });

  await check('suggestions: exec -> exact + first word + first two words; control -> exact only', () => {
    assert.deepEqual(allowSuggestions('ws_exec', { command: 'npm run build' }), [
      { kind: 'command', match: 'exact', value: 'npm run build' },
      { kind: 'command', match: 'prefix', value: 'npm' },
      { kind: 'command', match: 'prefix', value: 'npm run' },
    ]);
    // Interpreter/wrapper as the first word: no one-word prefix.
    assert.deepEqual(allowSuggestions('ws_exec', { command: 'git status --short' }), [
      { kind: 'command', match: 'exact', value: 'git status --short' },
      { kind: 'command', match: 'prefix', value: 'git status' },
    ]);
    assert.deepEqual(allowSuggestions('ws_exec', { command: 'bash' }), [
      { kind: 'command', match: 'exact', value: 'bash' },
    ]);
    assert.deepEqual(allowSuggestions('ws_exec', { command: 'npm test (x)' }), [
      { kind: 'command', match: 'exact', value: 'npm test (x)' },
    ]);
    assert.deepEqual(allowSuggestions('ws_exec', { command: '  ls  ' }), [
      { kind: 'command', match: 'exact', value: 'ls' },
      { kind: 'command', match: 'prefix', value: 'ls' },
    ]);
    assert.deepEqual(allowSuggestions('ws_exec', { command: 'a; b' }), [
      { kind: 'command', match: 'exact', value: 'a; b' },
    ]);
    assert.deepEqual(allowSuggestions('ws_exec', { command: 'x'.repeat(501) }), []);
    assert.deepEqual(allowSuggestions('ws_exec', {}), []);
  });

  await check('suggestions: file tools -> their files.* kind; read tools -> none', () => {
    assert.deepEqual(allowSuggestions('ws_write', { path: 'a' }), [{ kind: 'files.write' }]);
    assert.deepEqual(allowSuggestions('ws_edit', { path: 'a' }), [{ kind: 'files.write' }]);
    assert.deepEqual(allowSuggestions('ws_mkdir', { path: 'a' }), [{ kind: 'files.structure' }]);
    assert.deepEqual(allowSuggestions('ws_move', { from: 'a', to: 'b' }), [{ kind: 'files.structure' }]);
    assert.deepEqual(allowSuggestions('ws_delete', { path: 'a' }), [{ kind: 'files.delete' }]);
    assert.deepEqual(allowSuggestions('ws_read', { path: 'a' }), []);
    assert.deepEqual(allowSuggestions('todo_create', {}), []);
  });

  await check('every suggestion is accepted by parseAgentAllowInput', () => {
    for (const cmd of ['git status --short', 'npm test', 'a; b', 'make', 'env FOO=1 make', 'node x.js']) {
      for (const s of allowSuggestions('ws_exec', { command: cmd })) {
        assert.deepEqual(allowModule.parseAgentAllowInput(s), s);
      }
    }
  });
}

async function headTailChecks() {
  const { HeadTailOutput, headTailText, EXEC_HEAD_BYTES } = loadCompiled('workspaces/fs/head-tail-output.js');
  await check('HeadTailOutput: bounded, char boundaries intact, omitted count exact', () => {
    for (const max of [10, 200, 1000, 32 * 1024]) {
      const out = new HeadTailOutput(max);
      let pushed = 0;
      for (let i = 0; i < 500; i += 1) { const c = Buffer.from(`ä€😀${i}\n`); out.push(c); pushed += c.length; }
      const text = out.text();
      assert.ok(Buffer.byteLength(text) <= max, `${max}: ${Buffer.byteLength(text)}`);
      assert.ok(!text.includes('\uFFFD'), `${max}: replacement char`);
      if (max >= 1000) assert.ok(text.endsWith('😀499\n'), `${max}: tail`);
      if (max >= 1000 && out.truncated) {
        const m = /… (\d+) bytes omitted …/.exec(text);
        const kept = Buffer.byteLength(text) - Buffer.byteLength(m[0]) - 2;
        assert.equal(Number(m[1]), pushed - kept);
      }
    }
    const small = new HeadTailOutput(64 * 1024);
    small.push('a'); small.push('b');
    assert.equal(small.text(), 'ab');
    assert.equal(small.truncated, false);
    assert.equal(EXEC_HEAD_BYTES, 8 * 1024);
    assert.deepEqual(headTailText('abc', 10), { text: 'abc', cut: false });
  });
}

// ---- Step 1: tools over a temp directory ----------------------------------------

const tmpRoots = [];
const LIMITS = { editorMaxBytes: 1024 * 1024, downloadMaxBytes: 2 * 1024 ** 3 };

/** A workspace root in a temp dir, an SshFsBackend over the local fake on it. */
function makeFsRoot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-wsagent-'));
  tmpRoots.push(base);
  const root = path.join(base, 'srv');
  fs.mkdirSync(root);
  const fake = createLocalRemoteSession(base, RemoteError);
  return { base, root, fake, f: (rel) => path.join(root, rel) };
}

/**
 * Container workspaces: `backends.for` hands out a backend over a temp dir.
 * SSH workspaces: the real `WorkspaceFsBackends` wiring with fake sessions.
 */
function makeEnv(opts = {}) {
  const roots = new Map();
  const docs = new Map();
  const findCalls = [];
  const logs = [];
  const sshAudits = [];
  const forCalls = [];
  const connection = { _id: oid(), label: 'prod', host: 'srv.example', username: 'deploy', maxUploadBytes: 1 << 20 };
  const workspaces = {
    findById: async (id) => {
      findCalls.push(id);
      const ws = docs.get(id);
      if (!ws) throw new NotFoundException(`Workspace ${id} not found`);
      return ws;
    },
    touchThrottled() {},
  };
  const access = { resolve: async () => connection };
  const sessions = {
    withSession: async (wsId, connId, fn) => fn(roots.get(wsId).fake.session),
    drop() {},
  };
  const connector = {
    resolveUploadLimit: async (c) => c.maxUploadBytes,
    writeAudit: (entry) => { sshAudits.push(entry); return Promise.resolve(); },
  };
  const realBackends = new WorkspaceFsBackends({ ensureDir: async () => undefined }, sessions, connector, access, {});
  const backends = {
    for: async (ws, conn, o) => {
      forCalls.push({ id: String(ws._id), conn, opts: o });
      if (ws.location === 'ssh') return realBackends.for(ws, conn, o);
      const r = roots.get(String(ws._id));
      return new SshFsBackend(r.root, (fn) => fn(r.fake.session), () => undefined, { uploadMaxBytes: 1 << 20 });
    },
  };
  const limits = { get: async () => ({ ...LIMITS, ...(opts.limits || {}) }) };
  const logsSvc = { create: async (d) => { logs.push(d); } };
  const tools = new WorkspaceAgentTools(workspaces, backends, access, limits, logsSvc);
  function addWorkspace(over = {}) {
    const r = makeFsRoot();
    const _id = oid();
    const ws = {
      _id, projectId: oid(), name: 'w', status: 'active', location: 'container', agentMode: 'confirm', agentAllow: [],
      ...over,
    };
    if (ws.location === 'ssh') { ws.sshConnectionId = connection._id; ws.remotePath = r.root; }
    roots.set(String(_id), r);
    docs.set(String(_id), ws);
    return { id: String(_id), ws, ...r };
  }
  return { tools, addWorkspace, findCalls, logs, sshAudits, forCalls, connection };
}

const run = (env, w, name, args, pinned, actor = ADMIN, signal) =>
  asUser(() => env.tools.execute(name, args, { workspaceId: w.id, ...(signal ? { signal } : {}) }, pinned), actor);
const prev = (env, w, name, args, actor = ADMIN) =>
  asUser(() => env.tools.preview(name, args, { workspaceId: w.id }), actor);

async function toolChecks() {
  await check('definitions: ten tools, no workspaceId/projectId parameters', () => {
    const env = makeEnv();
    const defs = env.tools.definitions();
    assert.deepEqual(defs.map((d) => d.name), [...WORKSPACE_AGENT_TOOLS]);
    for (const d of defs) {
      assert.equal(d.parameters.type, 'object');
      for (const k of ['workspaceId', 'projectId', 'id']) {
        assert.ok(!(k in d.parameters.properties), `${d.name} declares ${k}`);
      }
    }
  });

  await check('paths: ../x and /etc/passwd -> path outside workspace (all path tools)', async () => {
    const env = makeEnv();
    const w = env.addWorkspace();
    for (const p of ['../x', '/etc/passwd', 'a/../../x', '..', 'C:\\x']) {
      for (const [name, args] of [
        ['ws_read', { path: p }], ['ws_tree', { path: p }], ['ws_write', { path: p, content: 'x' }],
        ['ws_edit', { path: p, oldText: 'a', newText: 'b' }], ['ws_mkdir', { path: p }], ['ws_delete', { path: p }],
        ['ws_move', { from: 'a', to: p }], ['ws_move', { from: p, to: 'a' }],
      ]) {
        const r = await run(env, w, name, args);
        assert.equal(r.success, false, `${name} ${p}`);
        assert.match(r.error, /path outside workspace/, `${name} ${p}: ${r.error}`);
      }
    }
    assert.ok(!fs.existsSync(path.join(w.base, 'x')));
  });

  await check('workspaceId/projectId arguments of another workspace are ignored', async () => {
    const env = makeEnv();
    const a = env.addWorkspace();
    const b = env.addWorkspace();
    fs.writeFileSync(a.f('f.txt'), 'from A');
    fs.writeFileSync(b.f('f.txt'), 'from B');
    const r = await run(env, a, 'ws_read', { path: 'f.txt', workspaceId: b.id, projectId: String(b.ws.projectId), id: b.id });
    assert.equal(r.success, true, r.error);
    assert.equal(r.result.content, 'from A');
    const w = await run(env, a, 'ws_write', { path: 'g.txt', content: 'x', workspaceId: b.id });
    assert.equal(w.success, true, w.error);
    assert.ok(fs.existsSync(a.f('g.txt')) && !fs.existsSync(b.f('g.txt')));
    assert.ok(env.findCalls.every((id) => id === a.id), JSON.stringify(env.findCalls));
  });

  await check('ws_read: whole file and line range; hash of the whole file; totalLines', async () => {
    const env = makeEnv();
    const w = env.addWorkspace();
    const text = 'l1\nl2\nl3\nl4\n';
    fs.writeFileSync(w.f('f.txt'), text);
    const all = await run(env, w, 'ws_read', { path: 'f.txt' });
    assert.equal(all.success, true, all.error);
    assert.equal(all.result.content, text);
    assert.equal(all.result.hash, sha(text));
    assert.equal(all.result.totalLines, 4);
    assert.equal(all.result.path, 'f.txt');
    assert.ok(!('startLine' in all.result));
    const part = await run(env, w, 'ws_read', { path: 'f.txt', startLine: 2, endLine: 3 });
    assert.equal(part.success, true, part.error);
    assert.equal(part.result.content, 'l2\nl3');
    assert.equal(part.result.hash, sha(text));
    assert.equal(part.result.totalLines, 4);
    assert.equal(part.result.startLine, 2);
    assert.equal(part.result.endLine, 3);
    const tail = await run(env, w, 'ws_read', { path: 'f.txt', startLine: 3, endLine: 99 });
    assert.equal(tail.result.content, 'l3\nl4');
    assert.equal(tail.result.endLine, 4);
    const beyond = await run(env, w, 'ws_read', { path: 'f.txt', startLine: 9 });
    assert.equal(beyond.success, false);
    const inverted = await run(env, w, 'ws_read', { path: 'f.txt', startLine: 3, endLine: 2 });
    assert.equal(inverted.success, false);
    const missing = await run(env, w, 'ws_read', { path: 'nope.txt' });
    assert.equal(missing.success, false);
    assert.match(missing.error, /not found/i);
  });

  await check('ws_read: editorMaxBytes limit -> error', async () => {
    const env = makeEnv({ limits: { editorMaxBytes: 10 } });
    const w = env.addWorkspace();
    fs.writeFileSync(w.f('big.txt'), 'x'.repeat(11));
    const r = await run(env, w, 'ws_read', { path: 'big.txt' });
    assert.equal(r.success, false);
    assert.match(r.error, /too large/);
  });

  await check('ws_tree / ws_search / ws_status: like the /fs routes', async () => {
    const env = makeEnv();
    const w = env.addWorkspace();
    fs.mkdirSync(w.f('src'));
    fs.writeFileSync(w.f('src/a.ts'), 'const needle = 1;\n');
    fs.writeFileSync(w.f('b.txt'), 'b');
    const t = await run(env, w, 'ws_tree', {});
    assert.equal(t.success, true, t.error);
    assert.deepEqual(t.result.entries.map((e) => [e.name, e.type]), [['src', 'dir'], ['b.txt', 'file']]);
    const t2 = await run(env, w, 'ws_tree', { path: 'src' });
    assert.deepEqual(t2.result.entries.map((e) => e.path), ['src/a.ts']);
    const empty = await run(env, w, 'ws_search', { query: '' });
    assert.equal(empty.success, false);
    const st = await run(env, w, 'ws_status', {});
    assert.equal(typeof st.success, 'boolean');
  });

  await check('ws_edit: 0 matches -> text not found; 2 -> ambiguous; 1 -> written', async () => {
    const env = makeEnv();
    const w = env.addWorkspace();
    fs.writeFileSync(w.f('f.txt'), 'alpha beta alpha gamma');
    const none = await run(env, w, 'ws_edit', { path: 'f.txt', oldText: 'delta', newText: 'x' });
    assert.equal(none.success, false);
    assert.match(none.error, /text not found/);
    const two = await run(env, w, 'ws_edit', { path: 'f.txt', oldText: 'alpha', newText: 'x' });
    assert.equal(two.success, false);
    assert.match(two.error, /text is ambiguous \(2 matches\)/);
    const one = await run(env, w, 'ws_edit', { path: 'f.txt', oldText: 'beta', newText: '$& $1 b' });
    assert.equal(one.success, true, one.error);
    assert.equal(fs.readFileSync(w.f('f.txt'), 'utf8'), 'alpha $& $1 b alpha gamma');
    assert.deepEqual(one.changedPaths, ['f.txt']);
    assert.equal(one.result.hash, sha('alpha $& $1 b alpha gamma'));
    const emptyOld = await run(env, w, 'ws_edit', { path: 'f.txt', oldText: '', newText: 'x' });
    assert.equal(emptyOld.success, false);
  });

  await check('ws_edit: pinned baseHash after a foreign change -> conflict', async () => {
    const env = makeEnv();
    const w = env.addWorkspace();
    fs.writeFileSync(w.f('f.txt'), 'one two');
    const p = await prev(env, w, 'ws_edit', { path: 'f.txt', oldText: 'two', newText: '2' });
    assert.equal(p.ok, true, p.error);
    fs.writeFileSync(w.f('f.txt'), 'one two three');
    const r = await run(env, w, 'ws_edit', { path: 'f.txt', oldText: 'two', newText: '2' }, { baseHash: p.preview.baseHash });
    assert.equal(r.success, false);
    assert.match(r.error, /conflict: file changed since the proposal/);
    assert.equal(fs.readFileSync(w.f('f.txt'), 'utf8'), 'one two three');
  });

  await check('ws_write: new file, existing file without baseHash, stale args.baseHash, pinned conflict', async () => {
    const env = makeEnv();
    const w = env.addWorkspace();
    const created = await run(env, w, 'ws_write', { path: 'n.txt', content: 'new' });
    assert.equal(created.success, true, created.error);
    assert.equal(fs.readFileSync(w.f('n.txt'), 'utf8'), 'new');
    assert.deepEqual(created.changedPaths, ['n.txt']);
    assert.equal(created.result.hash, sha('new'));
    const over = await run(env, w, 'ws_write', { path: 'n.txt', content: 'newer' });
    assert.equal(over.success, true, over.error);
    assert.equal(fs.readFileSync(w.f('n.txt'), 'utf8'), 'newer');
    const stale = await run(env, w, 'ws_write', { path: 'n.txt', content: 'x', baseHash: sha('new') });
    assert.equal(stale.success, false);
    assert.match(stale.error, /conflict/);
    // pinned: the hash read when the proposal was made
    const p = await prev(env, w, 'ws_write', { path: 'n.txt', content: 'proposal' });
    assert.equal(p.ok, true, p.error);
    fs.writeFileSync(w.f('n.txt'), 'foreign change');
    const r = await run(env, w, 'ws_write', { path: 'n.txt', content: 'proposal' }, { baseHash: p.preview.baseHash });
    assert.equal(r.success, false);
    assert.match(r.error, /conflict: file changed since the proposal/);
    assert.equal(fs.readFileSync(w.f('n.txt'), 'utf8'), 'foreign change');
    // pinned null (new file at proposal time) but the file appeared meanwhile
    const p2 = await prev(env, w, 'ws_write', { path: 'm.txt', content: 'm' });
    assert.equal(p2.preview.baseHash, null);
    fs.writeFileSync(w.f('m.txt'), 'appeared');
    const r2 = await run(env, w, 'ws_write', { path: 'm.txt', content: 'm' }, { baseHash: null });
    assert.match(r2.error, /conflict: file changed since the proposal/);
    // pinned and unchanged -> written
    const p3 = await prev(env, w, 'ws_write', { path: 'm.txt', content: 'ok' });
    const r3 = await run(env, w, 'ws_write', { path: 'm.txt', content: 'ok' }, { baseHash: p3.preview.baseHash });
    assert.equal(r3.success, true, r3.error);
    assert.equal(fs.readFileSync(w.f('m.txt'), 'utf8'), 'ok');
  });

  await check('ws_write: content over editorMaxBytes -> error, nothing written', async () => {
    const env = makeEnv({ limits: { editorMaxBytes: 4 } });
    const w = env.addWorkspace();
    const r = await run(env, w, 'ws_write', { path: 'n.txt', content: '12345' });
    assert.equal(r.success, false);
    assert.match(r.error, /too large/);
    assert.ok(!fs.existsSync(w.f('n.txt')));
  });

  await check('ws_mkdir / ws_move / ws_delete: done, changedPaths, workspace_ide log tagged agent', async () => {
    const env = makeEnv();
    const w = env.addWorkspace();
    const mk = await run(env, w, 'ws_mkdir', { path: 'd' });
    assert.equal(mk.success, true, mk.error);
    assert.deepEqual(mk.changedPaths, ['d']);
    fs.writeFileSync(w.f('a.txt'), 'a');
    const mv = await run(env, w, 'ws_move', { from: 'a.txt', to: 'd/b.txt' });
    assert.equal(mv.success, true, mv.error);
    assert.deepEqual(mv.changedPaths, ['a.txt', 'd/b.txt']);
    assert.equal(fs.readFileSync(w.f('d/b.txt'), 'utf8'), 'a');
    const del = await run(env, w, 'ws_delete', { path: 'd' });
    assert.equal(del.success, true, del.error);
    assert.deepEqual(del.changedPaths, ['d']);
    assert.ok(!fs.existsSync(w.f('d')));
    const gone = await run(env, w, 'ws_delete', { path: 'd' });
    assert.equal(gone.success, false);
    assert.equal(gone.changedPaths, undefined);
    await new Promise((r) => setImmediate(r));
    const tagged = env.logs.filter((l) => l.tags.includes('workspace_ide'));
    assert.ok(tagged.length >= 3, JSON.stringify(env.logs));
    for (const l of tagged) {
      assert.ok(l.tags.includes('agent'), JSON.stringify(l.tags));
      assert.ok(l.tags.includes(`ws:${w.id}`));
      assert.equal(l.metadata.agent, true);
      assert.equal(l.metadata.workspaceId, w.id);
    }
    assert.ok(tagged.some((l) => /move/.test(l.message)));
    assert.ok(tagged.some((l) => /delete/.test(l.message)));
  });

  await check('read tools return no changedPaths; write tools on failure neither', async () => {
    const env = makeEnv();
    const w = env.addWorkspace();
    fs.writeFileSync(w.f('f.txt'), 'x');
    const r = await run(env, w, 'ws_read', { path: 'f.txt' });
    assert.equal(r.changedPaths, undefined);
  });

  await check('workspace archived -> error (execute and preview)', async () => {
    const env = makeEnv();
    const w = env.addWorkspace({ status: 'archived' });
    fs.writeFileSync(w.f('f.txt'), 'x');
    const r = await run(env, w, 'ws_read', { path: 'f.txt' });
    assert.equal(r.success, false);
    assert.match(r.error, /workspace is archived/);
    const p = await prev(env, w, 'ws_write', { path: 'f.txt', content: 'y' });
    assert.equal(p.ok, false);
    assert.match(p.error, /workspace is archived/);
    assert.equal(env.forCalls.length, 0, 'no backend for an inactive workspace');
  });

  await check('actor without write permission -> error for read and write tools, preview too', async () => {
    const env = makeEnv();
    const w = env.addWorkspace();
    fs.writeFileSync(w.f('f.txt'), 'x');
    for (const [name, args] of [['ws_read', { path: 'f.txt' }], ['ws_tree', {}], ['ws_write', { path: 'f.txt', content: 'y' }]]) {
      const r = await run(env, w, name, args, undefined, READ_ONLY);
      assert.equal(r.success, false, name);
      assert.match(r.error, /permission/, `${name}: ${r.error}`);
    }
    const p = await prev(env, w, 'ws_write', { path: 'f.txt', content: 'y' }, READ_ONLY);
    assert.equal(p.ok, false);
    assert.equal(fs.readFileSync(w.f('f.txt'), 'utf8'), 'x');
    assert.equal(env.findCalls.length, 0);
  });

  await check('unknown / foreign workspace id -> error, no throw', async () => {
    const env = makeEnv();
    const r = await asUser(() => env.tools.execute('ws_read', { path: 'a' }, { workspaceId: oid().toString() }));
    assert.equal(r.success, false);
    assert.match(r.error, /not found/);
    const bad = await asUser(() => env.tools.execute('ws_read', { path: 'a' }, { workspaceId: '$ne' }));
    assert.equal(bad.success, false);
    const unknown = await asUser(() => env.tools.execute('ws_nope', {}, { workspaceId: oid().toString() }));
    assert.equal(unknown.success, false);
  });

  await check('ws_exec (ssh): via /bin/sh -c in the root; head + tail within 64 KiB; exit code kept; changedPaths ["."]', async () => {
    const env = makeEnv();
    const w = env.addWorkspace({ location: 'ssh' });
    const big = (c) => `FIRST-${c}\n${c.repeat(3 * 1024 * 1024)}\nLAST-${c}`;
    w.fake.switches.execScript = { code: 3, stdout: big('a'), stderr: big('e') };
    const r = await run(env, w, 'ws_exec', { command: 'npm test' });
    assert.equal(r.success, true, r.error);
    const { exitCode, stdout, stderr, truncated, timedOut, aborted } = r.result;
    assert.ok(Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= 64 * 1024);
    assert.ok(stdout.startsWith('FIRST-a') && stdout.endsWith('LAST-a'), stdout.slice(-40));
    assert.ok(stderr.startsWith('FIRST-e') && stderr.endsWith('LAST-e'));
    assert.match(stdout, /… \d+ bytes omitted …/);
    assert.equal(truncated, true);
    assert.equal(timedOut, false);
    assert.equal(aborted, false);
    assert.equal(exitCode, 3, 'not killed for its output');
    assert.deepEqual(r.changedPaths, ['.']);
    assert.equal(w.fake.calls.agentExecs.length, 1);
    assert.match(w.fake.calls.agentExecs[0], /^cd -- '.*' && exec \/bin\/sh -c 'npm test'$/);
    assert.deepEqual(w.fake.calls.agentCommands, ['npm test']);
    assert.equal(w.fake.calls.execOpts[0].outputMode, 'headTail');
  });

  await check('no authenticated user -> execute and preview fail closed', async () => {
    const env = makeEnv();
    const w = env.addWorkspace();
    fs.writeFileSync(w.f('f.txt'), 'x');
    const r = await env.tools.execute('ws_read', { path: 'f.txt' }, { workspaceId: w.id });
    assert.deepEqual(r, { success: false, error: 'no authenticated user' });
    const p = await env.tools.preview('ws_write', { path: 'f.txt', content: 'y' }, { workspaceId: w.id });
    assert.deepEqual(p, { ok: false, error: 'no authenticated user' });
    assert.equal(env.findCalls.length, 0);
  });

  await check('ws_exec (ssh): small output untouched, exit code; timeoutSec clamped; signal passed', async () => {
    const env = makeEnv();
    const w = env.addWorkspace({ location: 'ssh' });
    w.fake.switches.execScript = { code: 2, stdout: 'out', stderr: 'err' };
    const r = await run(env, w, 'ws_exec', { command: 'make', timeoutSec: 5000 });
    assert.equal(r.success, true, r.error);
    assert.deepEqual(r.result, { exitCode: 2, stdout: 'out', stderr: 'err', truncated: false, timedOut: false, aborted: false });
    const opts = w.fake.calls.execOpts[w.fake.calls.execOpts.length - 1];
    assert.equal(opts.timeoutMs, 600_000);
    const ac = new AbortController();
    w.fake.switches.execScript = { stdout: 'partial', delayMs: 200 };
    setTimeout(() => ac.abort(), 20);
    const a = await run(env, w, 'ws_exec', { command: 'sleep 9' }, undefined, ADMIN, ac.signal);
    assert.equal(a.success, true, a.error);
    assert.equal(a.result.aborted, true);
    assert.equal(w.fake.calls.aborts, 1);
    const empty = await run(env, w, 'ws_exec', { command: '   ' });
    assert.equal(empty.success, false);
  });

  await check('ssh: audit rows carry agent: true; access.resolve used; schema accepts agent', async () => {
    const env = makeEnv();
    const w = env.addWorkspace({ location: 'ssh' });
    const r = await run(env, w, 'ws_write', { path: 'f.txt', content: 'x' });
    assert.equal(r.success, true, r.error);
    const writes = env.sshAudits.filter((a) => a.action === 'write');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].agent, true);
    assert.equal(writes[0].sourceContext, 'ide');
    assert.equal(writes[0].userId, USER_ID);
    assert.ok(env.forCalls.every((c) => c.conn === env.connection && c.opts && c.opts.agent === true));
    const Model = mongoose.models.SshAuditAgentCheck || mongoose.model('SshAuditAgentCheck', SshAuditSchema);
    const doc = new Model({ connectionId: oid(), action: 'write', sourceContext: 'ide', userId: oid(), workspaceId: oid(), agent: true });
    assert.equal(doc.validateSync(), undefined);
    assert.equal(doc.agent, true);
  });

  await check('preview: ws_write new + existing, ws_edit, ws_edit unexecutable, paths, command', async () => {
    const env = makeEnv();
    const w = env.addWorkspace();
    fs.writeFileSync(w.f('f.txt'), 'old text');
    const n = await prev(env, w, 'ws_write', { path: 'new.txt', content: 'hello' });
    assert.deepEqual(n, { ok: true, preview: { kind: 'file', path: 'new.txt', before: null, after: 'hello', baseHash: null } });
    const e = await prev(env, w, 'ws_write', { path: 'f.txt', content: 'new text' });
    assert.deepEqual(e, { ok: true, preview: { kind: 'file', path: 'f.txt', before: 'old text', after: 'new text', baseHash: sha('old text') } });
    const ed = await prev(env, w, 'ws_edit', { path: 'f.txt', oldText: 'old', newText: 'new' });
    assert.deepEqual(ed, { ok: true, preview: { kind: 'file', path: 'f.txt', before: 'old text', after: 'new text', baseHash: sha('old text') } });
    const bad = await prev(env, w, 'ws_edit', { path: 'f.txt', oldText: 'zzz', newText: 'new' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /text not found/);
    const missing = await prev(env, w, 'ws_edit', { path: 'nope.txt', oldText: 'a', newText: 'b' });
    assert.equal(missing.ok, false);
    const stale = await prev(env, w, 'ws_write', { path: 'f.txt', content: 'x', baseHash: sha('other') });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /conflict/);
    assert.deepEqual(await prev(env, w, 'ws_move', { from: 'a', to: 'b' }), { ok: true, preview: { kind: 'paths', from: 'a', to: 'b' } });
    assert.deepEqual(await prev(env, w, 'ws_delete', { path: 'f.txt' }), { ok: true, preview: { kind: 'paths', path: 'f.txt' } });
    assert.deepEqual(await prev(env, w, 'ws_mkdir', { path: 'd' }), { ok: true, preview: { kind: 'paths', path: 'd' } });
    const c = await prev(env, w, 'ws_exec', { command: ' npm test ' });
    assert.deepEqual(c, { ok: true, preview: { kind: 'command', command: 'npm test', timeoutSec: 60, cwd: `/workspaces/${w.id}` } });
    const c2 = await prev(env, w, 'ws_exec', { command: 'x', timeoutSec: 0 });
    assert.equal(c2.preview.timeoutSec, 1);
    const outside = await prev(env, w, 'ws_delete', { path: '../x' });
    assert.equal(outside.ok, false);
    assert.match(outside.error, /path outside workspace/);
    const ro = await prev(env, w, 'ws_read', { path: 'f.txt' });
    assert.equal(ro.ok, false);
    assert.equal(fs.readFileSync(w.f('f.txt'), 'utf8'), 'old text', 'preview never writes');
  });

  await check('preview (ssh): cwd is user@host:/path; over editorMaxBytes -> ok:false', async () => {
    const env = makeEnv({ limits: { editorMaxBytes: 8 } });
    const w = env.addWorkspace({ location: 'ssh' });
    const c = await prev(env, w, 'ws_exec', { command: 'ls', timeoutSec: 30 });
    assert.deepEqual(c, { ok: true, preview: { kind: 'command', command: 'ls', timeoutSec: 30, cwd: `deploy@srv.example:${w.root}` } });
    fs.writeFileSync(w.f('big.txt'), 'x'.repeat(9));
    const big = await prev(env, w, 'ws_write', { path: 'big.txt', content: 'y' });
    assert.equal(big.ok, false);
    assert.match(big.error, /too large/);
    const bigAfter = await prev(env, w, 'ws_write', { path: 'n.txt', content: 'y'.repeat(9) });
    assert.equal(bigAfter.ok, false);
    assert.match(bigAfter.error, /too large/);
  });
}

// ---- chat wiring -------------------------------------------------------------------

async function chatChecks() {
  const { TOOL_GROUPS, WRITE_TOOL_NAMES, ChatToolsService } = chatTools;

  await check('chat-tools: group workspace_agent, write tools in WRITE_TOOL_NAMES, read ones not', () => {
    assert.deepEqual([...TOOL_GROUPS.workspace_agent], [...WORKSPACE_AGENT_TOOLS]);
    for (const t of WORKSPACE_AGENT_TOOLS) {
      assert.equal(WRITE_TOOL_NAMES.has(t), WORKSPACE_AGENT_WRITE_TOOLS.has(t), t);
    }
  });

  await check('getToolsForLlm: ws_* only with includeAgentTools (and in the allowlist)', () => {
    const fake = Object.create(ChatToolsService.prototype);
    fake.logger = { warn() {} };
    fake.workspaceAgentTools = new WorkspaceAgentTools({}, {}, {}, {}, {});
    const all = chatTools.ALL_TOOL_NAMES;
    const without = fake.getToolsForLlm(all).map((t) => t.function.name);
    assert.ok(without.length > 0);
    assert.ok(!without.some((n) => n.startsWith('ws_')), 'no ws_* without includeAgentTools');
    const withAgent = fake.getToolsForLlm(all, true).map((t) => t.function.name);
    for (const t of WORKSPACE_AGENT_TOOLS) assert.ok(withAgent.includes(t), t);
    const onlyRead = fake.getToolsForLlm(['ws_read', 'todo_list'], true).map((t) => t.function.name);
    assert.deepEqual(onlyRead.sort(), ['todo_list', 'ws_read']);
  });

  await check('ChatToolsService.execute: ws_* without agentWorkspace -> error; with -> delegated', async () => {
    const fake = Object.create(ChatToolsService.prototype);
    fake.logger = { warn() {} };
    const calls = [];
    fake.workspaceAgentTools = {
      execute: async (name, args, ctx, pinned) => { calls.push({ name, args, ctx, pinned }); return { success: true, result: 1, changedPaths: ['a'] }; },
    };
    const no = await asUser(() => fake.execute('ws_write', { path: 'a', content: 'x' }, { projectId: 'p' }, ['ws_write']));
    assert.deepEqual(no, { success: false, error: 'ws_* tools are only available in the IDE agent' });
    assert.equal(calls.length, 0);
    const ctx = { projectId: 'p', agentWorkspace: { workspaceId: 'w1' } };
    const notAllowed = await asUser(() => fake.execute('ws_write', { path: 'a', content: 'x' }, ctx, ['ws_read']));
    assert.equal(notAllowed.success, false);
    assert.equal(calls.length, 0);
    const yes = await asUser(() => fake.execute('ws_write', { path: 'a', content: 'x' }, ctx, ['ws_write']));
    assert.equal(yes.success, true);
    assert.deepEqual(yes.changedPaths, ['a']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ctx, ctx.agentWorkspace);
  });

  await check('browser path: executeTool refuses ws_write despite the allowlist', async () => {
    const executed = [];
    const session = { projectId: oid() };
    const chatService = { findById: async () => session };
    const llm = { isEnabled: async () => true, getOptions: async () => ({ toolsAllowlist: [...WORKSPACE_AGENT_TOOLS, 'todo_list'] }) };
    const tools = { execute: async (n) => { executed.push(n); return { success: true, result: {} }; } };
    const c = new ChatController(chatService, llm, {}, tools, {}, {}, {}, {}, {});
    for (const name of ['ws_write', 'ws_exec', 'ws_read']) {
      const r = await c.executeTool('s1', { name, arguments: { path: 'a', content: 'x' } }, { user: { userId: USER_ID } });
      assert.equal(r.success, false, name);
      assert.equal(r.error, 'ws_* tools cannot run through the browser path');
    }
    assert.deepEqual(executed, []);
  });
}

(async () => {
  try {
    await pureChecks();
    await headTailChecks();
    await toolChecks();
    await chatChecks();
  } finally {
    for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
  }
  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
})();
