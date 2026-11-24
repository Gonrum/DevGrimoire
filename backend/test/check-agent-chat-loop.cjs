#!/usr/bin/env node
/*
 * Workspace agent chat, Task 4: the IDE agent in the server-side tool loop.
 * - IDE sessions get ws_* (bound to the session's workspace), other sessions not
 * - per call: ws_* write tools pause only in mode `confirm` and when the
 *   workspace's allow list does not cover the call; other write tools pause as before
 * - server-side preview in `tool_confirm`, pinned hash, resume, "always allow"
 * - `workspace_changed`, `proposal_expired`, abort reaches ws_exec
 *
 * Drives `ChatController.sendMessage` / `resumeTool` with a scripted fake LLM,
 * the real `ChatToolsService.execute` routing and the real `WorkspaceAgentTools`
 * over a temp directory (local stand-in session). No database, no network.
 * Loads from dist/; run `npm run build` first.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
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

const { WorkspaceAgentTools, WORKSPACE_AGENT_TOOLS } = loadCompiled('chat/workspace-agent-tools.js');
const { ChatToolsService } = loadCompiled('chat/chat-tools.js');
const { ChatController } = loadCompiled('chat/chat.controller.js');
const { WorkspacesService } = loadCompiled('workspaces/workspaces.service.js');
const { RemoteError } = loadCompiled('workspaces/fs/remote-session.js');
const { SshFsBackend } = loadCompiled('workspaces/fs/ssh-fs-backend.js');
const { createLocalRemoteSession } = require('./lib/local-remote-session.cjs');
const mongoose = nm('mongoose');
const { NotFoundException } = nm('@nestjs/common');

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`ok  ${label}`); }
  catch (err) { failures += 1; console.error(`FAIL ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const oid = () => new mongoose.Types.ObjectId();
const USER_ID = oid().toString();
const ADMIN = { userId: USER_ID, username: 'u', role: 'admin' };
const LIMITS = { editorMaxBytes: 1024 * 1024, downloadMaxBytes: 2 * 1024 ** 3 };
const tmpRoots = [];

/**
 * One environment: a workspace on a temp dir, a chat session, a fake LLM that
 * answers each `streamChatWithTools` call with the next scripted round.
 */
function makeEnv(opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-agentloop-'));
  tmpRoots.push(base);
  const root = path.join(base, 'srv');
  fs.mkdirSync(root);
  const fake = createLocalRemoteSession(base, RemoteError);
  const projectId = oid();
  const wsId = oid();
  const wsDoc = {
    _id: wsId, projectId, name: 'w', status: 'active', location: 'container',
    agentMode: opts.agentMode ?? 'confirm', agentAllow: opts.agentAllow ?? [],
  };
  const otherWsId = oid();
  const otherWs = { ...wsDoc, _id: otherWsId, agentAllow: [] };
  const docs = new Map([[String(wsId), wsDoc], [String(otherWsId), otherWs]]);

  // Real WorkspacesService.addAgentAllow over a fake model (same path as POST agent-allow).
  const workspaces = Object.create(WorkspacesService.prototype);
  workspaces.findById = async (id) => {
    const ws = docs.get(String(id));
    if (!ws) throw new NotFoundException(`Workspace ${id} not found`);
    return ws;
  };
  workspaces.touchThrottled = () => {};
  const allowAdds = [];
  workspaces.workspaceModel = {
    findOneAndUpdate: (filter, update) => ({
      exec: async () => {
        const ws = docs.get(String(filter._id));
        allowAdds.push(update.$push.agentAllow);
        ws.agentAllow = [...ws.agentAllow, update.$push.agentAllow];
        return ws;
      },
    }),
  };

  const backends = {
    for: async () => new SshFsBackend(root, (fn) => fn(fake.session), () => undefined, { uploadMaxBytes: 1 << 20 }),
  };
  const agentTools = new WorkspaceAgentTools(
    workspaces, backends, { resolve: async () => null }, { get: async () => LIMITS }, { create: async () => undefined },
  );
  const tools = Object.create(ChatToolsService.prototype);
  tools.logger = { warn() {}, debug() {} };
  tools.workspaceAgentTools = agentTools;
  const otherExecuted = [];
  const realExecute = tools.execute;
  tools.execute = async function (name, args, ctx, allowlist, pinned) {
    if (name.startsWith('ws_')) return realExecute.call(this, name, args, ctx, allowlist, pinned);
    otherExecuted.push(name);
    return { success: true, result: { ok: true } };
  };

  const rounds = [...(opts.rounds ?? [])];
  const llmCalls = [];
  const llm = {
    isEnabled: async () => true,
    getOptions: async () => ({
      enabled: true, toolsEnabled: true, topK: 3, historyLimit: 10, toolsMaxIterations: 10,
      toolsAllowlist: opts.allowlist ?? [...WORKSPACE_AGENT_TOOLS, 'todo_create', 'todo_list'],
    }),
    async *streamChatWithTools(conversation, toolDefs) {
      llmCalls.push({ conversation: conversation.map((m) => ({ ...m })), tools: toolDefs.map((t) => t.function.name) });
      const round = rounds.shift() ?? [{ type: 'content', delta: 'fertig' }, { type: 'finish', reason: 'stop' }];
      for (const ev of round) yield ev;
    },
  };
  const session = {
    _id: oid(), projectId, messages: [],
    ...(opts.ide === false ? {} : { ideAgent: true, workspaceId: wsId }),
  };
  const appended = [];
  const chatService = {
    findById: async () => session,
    appendMessage: async (id, m) => { appended.push(m); },
  };
  const contextCalls = [];
  const context = {
    build: async (owner, content, history, o) => {
      contextCalls.push(o);
      return { messages: [{ role: 'user', content }], contextRefs: [], images: undefined };
    },
  };
  const activity = { record: async () => undefined };
  const c = new ChatController(chatService, llm, context, tools, {}, {}, workspaces, activity, {});
  return {
    c, root, fake, wsDoc, otherWs, session, llmCalls, allowAdds, otherExecuted, appended, contextCalls, rounds,
    f: (rel) => path.join(root, rel),
  };
}

function fakeReq(user = ADMIN) {
  const req = new EventEmitter();
  req.user = user;
  req.apiKey = undefined;
  return req;
}

function fakeRes() {
  const res = {
    events: [], ended: false, headers: {},
    get writableEnded() { return this.ended; },
    setHeader(k, v) { this.headers[k] = v; },
    flushHeaders() {},
    write(chunk) {
      for (const line of String(chunk).split('\n')) {
        if (line.startsWith('data: ')) res.events.push(JSON.parse(line.slice(6)));
      }
    },
    end() { this.ended = true; },
  };
  return res;
}

const tc = (id, name, args) => ({ type: 'tool_call', id, name, arguments: JSON.stringify(args) });
const round = (...calls) => [...calls, { type: 'finish', reason: 'tool_calls' }];
const ofType = (res, type) => res.events.filter((e) => e.type === type);

async function send(env, content = 'go', req = fakeReq()) {
  const res = fakeRes();
  await env.c.sendMessage(String(env.session._id), { content, workspaceId: String(env.otherWs._id) }, req, res);
  return res;
}
async function resume(env, body, req = fakeReq()) {
  const res = fakeRes();
  await env.c.resumeTool(String(env.session._id), body, req, res);
  return res;
}
/** The tool message the LLM got for a call id, in the last LLM call. */
function toolMessage(env, id) {
  const last = env.llmCalls[env.llmCalls.length - 1];
  return last.conversation.find((m) => m.role === 'tool' && m.tool_call_id === id);
}

async function main() {
  await check('non-IDE session: no ws_* offered; ws_* call errors without asking', async () => {
    const env = makeEnv({ ide: false, rounds: [round(tc('w1', 'ws_write', { path: 'a.txt', content: 'x' }))] });
    const res = await send(env);
    assert.ok(!env.llmCalls[0].tools.some((n) => n.startsWith('ws_')), env.llmCalls[0].tools.join(','));
    assert.ok(env.llmCalls[0].tools.includes('todo_list'));
    assert.equal(ofType(res, 'tool_confirm').length, 0);
    assert.ok(!fs.existsSync(env.f('a.txt')));
    assert.match(toolMessage(env, 'w1').content, /only available in the IDE agent/);
    // The message's workspaceId is the context hint for normal sessions (unchanged).
    assert.equal(String(env.contextCalls[0].activeWorkspace._id), String(env.otherWs._id));
  });

  await check('IDE session: ws_* offered; context hint from the session, message workspaceId ignored', async () => {
    const env = makeEnv({ rounds: [[{ type: 'content', delta: 'hi' }, { type: 'finish', reason: 'stop' }]] });
    await send(env);
    for (const t of WORKSPACE_AGENT_TOOLS) assert.ok(env.llmCalls[0].tools.includes(t), t);
    assert.equal(String(env.contextCalls[0].activeWorkspace._id), String(env.wsDoc._id));
  });

  await check('confirm: tool_confirm with file preview + suggestions, nothing written', async () => {
    const env = makeEnv({ rounds: [round(tc('w1', 'ws_write', { path: 'a.txt', content: 'neu' }))] });
    fs.writeFileSync(env.f('a.txt'), 'alt');
    const res = await send(env);
    const [confirm] = ofType(res, 'tool_confirm');
    assert.ok(confirm, JSON.stringify(res.events));
    assert.equal(confirm.id, 'w1');
    assert.equal(confirm.preview.kind, 'file');
    assert.equal(confirm.preview.before, 'alt');
    assert.equal(confirm.preview.after, 'neu');
    assert.deepEqual(confirm.allowSuggestions, [{ kind: 'files.write' }]);
    assert.equal(fs.readFileSync(env.f('a.txt'), 'utf8'), 'alt');
    assert.equal(ofType(res, 'done').length, 0);
    assert.equal(res.ended, true);
  });

  await check('resume approved -> written + workspace_changed; LLM continues', async () => {
    const env = makeEnv({ rounds: [round(tc('w1', 'ws_write', { path: 'a.txt', content: 'neu' }))] });
    await send(env);
    const res = await resume(env, { callId: 'w1', approved: true });
    assert.equal(fs.readFileSync(env.f('a.txt'), 'utf8'), 'neu');
    assert.deepEqual(ofType(res, 'workspace_changed'), [{ type: 'workspace_changed', paths: ['a.txt'] }]);
    assert.equal(ofType(res, 'done').length, 1);
    assert.match(toolMessage(env, 'w1').content, /"hash"/);
  });

  await check('resume rejected -> nothing written, LLM learns "rejected"', async () => {
    const env = makeEnv({ rounds: [round(tc('w1', 'ws_write', { path: 'a.txt', content: 'neu' }))] });
    await send(env);
    const res = await resume(env, { callId: 'w1', approved: false });
    assert.ok(!fs.existsSync(env.f('a.txt')));
    assert.equal(ofType(res, 'workspace_changed').length, 0);
    assert.match(toolMessage(env, 'w1').content, /Rejected by the user/);
  });

  await check('direct: no tool_confirm, written + workspace_changed', async () => {
    const env = makeEnv({ agentMode: 'direct', rounds: [round(tc('w1', 'ws_write', { path: 'd/a.txt', content: 'x' }))] });
    fs.mkdirSync(env.f('d'));
    const res = await send(env);
    assert.equal(ofType(res, 'tool_confirm').length, 0);
    assert.equal(fs.readFileSync(env.f('d/a.txt'), 'utf8'), 'x');
    assert.deepEqual(ofType(res, 'workspace_changed').map((e) => e.paths), [['d/a.txt']]);
    assert.equal(ofType(res, 'done').length, 1);
  });

  await check('direct: todo_create still pauses', async () => {
    const env = makeEnv({ agentMode: 'direct', rounds: [round(tc('t1', 'todo_create', { title: 'x' }))] });
    const res = await send(env);
    const [confirm] = ofType(res, 'tool_confirm');
    assert.equal(confirm && confirm.id, 't1');
    assert.equal(confirm.preview, undefined);
    assert.deepEqual(env.otherExecuted, []);
  });

  await check('mode changed to direct between pause and resume: the turn keeps its start rule', async () => {
    const env = makeEnv({
      rounds: [
        round(tc('w1', 'ws_write', { path: 'a.txt', content: '1' })),
        round(tc('w2', 'ws_write', { path: 'b.txt', content: '2' })),
      ],
    });
    await send(env);
    env.wsDoc.agentMode = 'direct';
    const res = await resume(env, { callId: 'w1', approved: true });
    assert.equal(fs.readFileSync(env.f('a.txt'), 'utf8'), '1');
    const [confirm] = ofType(res, 'tool_confirm');
    assert.equal(confirm && confirm.id, 'w2', 'second write must still ask');
    assert.ok(!fs.existsSync(env.f('b.txt')));
  });

  await check('workspace archived between pause and resume -> error to the LLM, nothing written', async () => {
    const env = makeEnv({ rounds: [round(tc('w1', 'ws_write', { path: 'a.txt', content: 'x' }))] });
    await send(env);
    env.wsDoc.status = 'archived';
    const res = await resume(env, { callId: 'w1', approved: true });
    assert.ok(!fs.existsSync(env.f('a.txt')));
    const [result] = ofType(res, 'tool_result');
    assert.equal(result.success, false);
    assert.match(toolMessage(env, 'w1').content, /workspace is archived/);
    assert.equal(ofType(res, 'workspace_changed').length, 0);
  });

  await check('file changed between preview and resume -> conflict, not overwritten', async () => {
    const env = makeEnv({ rounds: [round(tc('w1', 'ws_write', { path: 'a.txt', content: 'agent' }))] });
    fs.writeFileSync(env.f('a.txt'), 'v1');
    await send(env);
    fs.writeFileSync(env.f('a.txt'), 'v2 by the user');
    await resume(env, { callId: 'w1', approved: true });
    assert.equal(fs.readFileSync(env.f('a.txt'), 'utf8'), 'v2 by the user');
    assert.match(toolMessage(env, 'w1').content, /conflict: file changed since the proposal/);
  });

  await check('unworkable ws_edit -> no tool_confirm, error to the LLM, turn goes on', async () => {
    const env = makeEnv({ rounds: [round(tc('e1', 'ws_edit', { path: 'a.txt', oldText: 'fehlt', newText: 'x' }))] });
    fs.writeFileSync(env.f('a.txt'), 'inhalt');
    const res = await send(env);
    assert.equal(ofType(res, 'tool_confirm').length, 0);
    assert.equal(env.llmCalls.length, 2, 'the LLM is asked again');
    assert.match(toolMessage(env, 'e1').content, /text not found/);
    assert.equal(ofType(res, 'done').length, 1);
  });

  await check('resume without an open proposal -> 404 proposal_expired', async () => {
    const env = makeEnv();
    await assert.rejects(resume(env, { callId: 'x', approved: true }), (err) => {
      assert.equal(err.getStatus(), 404);
      assert.deepEqual(err.getResponse(), { error: 'proposal_expired', message: 'Vorschlag verfallen — bitte erneut anfragen' });
      return true;
    });
  });

  await check('alwaysAllow exact "npm test": stored + run; next "npm test" without asking, "npm test -- -u" asks', async () => {
    const env = makeEnv({
      rounds: [
        round(tc('x1', 'ws_exec', { command: 'npm test' })),
        round(tc('x2', 'ws_exec', { command: 'npm test' }), tc('x3', 'ws_exec', { command: 'npm test -- -u' })),
      ],
    });
    env.fake.switches.execScript = { code: 0, stdout: 'ok' };
    const first = await send(env);
    const [c1] = ofType(first, 'tool_confirm');
    assert.equal(c1.preview.kind, 'command');
    assert.deepEqual(c1.allowSuggestions, [{ kind: 'command', match: 'exact', value: 'npm test' }]);
    const res = await resume(env, { callId: 'x1', approved: true, alwaysAllow: { kind: 'command', match: 'exact', value: 'npm test' } });
    assert.equal(env.allowAdds.length, 1);
    assert.deepEqual({ ...env.allowAdds[0], createdAt: undefined }, { kind: 'command', match: 'exact', value: 'npm test', createdAt: undefined });
    assert.deepEqual(env.fake.calls.agentCommands, ['npm test', 'npm test']);
    assert.deepEqual(ofType(res, 'tool_confirm').map((e) => e.id), ['x3']);
    assert.deepEqual(ofType(res, 'workspace_changed').map((e) => e.paths), [['.'], ['.']]);
  });

  await check('alwaysAllow files.write: stored, later ws_write in the same turn runs without asking', async () => {
    const env = makeEnv({
      rounds: [
        round(tc('w1', 'ws_write', { path: 'a.txt', content: '1' })),
        round(tc('w2', 'ws_edit', { path: 'a.txt', oldText: '1', newText: '2' })),
      ],
    });
    await send(env);
    const res = await resume(env, { callId: 'w1', approved: true, alwaysAllow: { kind: 'files.write' } });
    assert.equal(ofType(res, 'tool_confirm').length, 0);
    assert.equal(fs.readFileSync(env.f('a.txt'), 'utf8'), '2');
  });

  await check('alwaysAllow match prefix -> 400, nothing stored or run, proposal still open', async () => {
    const env = makeEnv({ rounds: [round(tc('x1', 'ws_exec', { command: 'npm test' }))] });
    env.fake.switches.execScript = { code: 0 };
    await send(env);
    await assert.rejects(
      resume(env, { callId: 'x1', approved: true, alwaysAllow: { kind: 'command', match: 'prefix', value: 'npm' } }),
      (err) => err.getStatus() === 400,
    );
    assert.equal(env.allowAdds.length, 0);
    assert.deepEqual(env.fake.calls.agentCommands, []);
    const res = await resume(env, { callId: 'x1', approved: false });
    assert.equal(ofType(res, 'done').length, 1, 'the proposal must still be resumable');
  });

  await check('alwaysAllow that does not cover the call -> 400, nothing stored or run', async () => {
    const env = makeEnv({ rounds: [round(tc('x1', 'ws_exec', { command: 'npm test' }))] });
    env.fake.switches.execScript = { code: 0 };
    await send(env);
    for (const alwaysAllow of [
      { kind: 'command', match: 'exact', value: 'npm run lint' },
      { kind: 'files.write' },
    ]) {
      await assert.rejects(resume(env, { callId: 'x1', approved: true, alwaysAllow }), (err) => err.getStatus() === 400);
    }
    await assert.rejects(
      resume(env, { callId: 'x1', approved: false, alwaysAllow: { kind: 'command', match: 'exact', value: 'npm test' } }),
      (err) => err.getStatus() === 400,
    );
    assert.equal(env.allowAdds.length, 0);
    assert.deepEqual(env.fake.calls.agentCommands, []);
  });

  await check('alwaysAllow for a non-ws_* write tool -> 400', async () => {
    const env = makeEnv({ rounds: [round(tc('t1', 'todo_create', { title: 'x' }))] });
    await send(env);
    await assert.rejects(
      resume(env, { callId: 't1', approved: true, alwaysAllow: { kind: 'files.write' } }),
      (err) => err.getStatus() === 400,
    );
    assert.deepEqual(env.otherExecuted, []);
  });

  await check('a stored allow entry is read per call (added during the turn -> applies)', async () => {
    const env = makeEnv({
      rounds: [
        round(tc('w1', 'ws_write', { path: 'a.txt', content: '1' })),
        round(tc('m1', 'ws_mkdir', { path: 'd' })),
      ],
    });
    await send(env);
    env.wsDoc.agentAllow = [{ kind: 'files.structure', createdAt: new Date() }];
    const res = await resume(env, { callId: 'w1', approved: true });
    assert.equal(ofType(res, 'tool_confirm').length, 0);
    assert.ok(fs.statSync(env.f('d')).isDirectory());
  });

  await check('abort during ws_exec -> the signal reaches the backend', async () => {
    const env = makeEnv({ agentMode: 'direct', rounds: [round(tc('x1', 'ws_exec', { command: 'sleep 100' }))] });
    env.fake.switches.execScript = { stdout: 'partial', delayMs: 5000 };
    const req = fakeReq();
    const started = Date.now();
    const p = send(env, 'go', req);
    await new Promise((r) => setTimeout(r, 100));
    req.emit('close');
    await p;
    assert.equal(env.fake.calls.aborts, 1);
    assert.ok(Date.now() - started < 3000, 'the exec must end on abort');
  });

  await check('persisted history: ws_write content cut to 4 KiB, live conversation keeps it whole', async () => {
    const big = 'x'.repeat(10000);
    const env = makeEnv({ agentMode: 'direct', rounds: [round(tc('w1', 'ws_write', { path: 'a.txt', content: big }))] });
    await send(env);
    assert.equal(fs.readFileSync(env.f('a.txt'), 'utf8'), big);
    const assistant = env.appended.find((m) => m.role === 'assistant');
    const rec = assistant.toolCalls.find((t) => t.id === 'w1');
    const args = JSON.parse(rec.arguments);
    assert.ok(Buffer.byteLength(args.content) <= 4096 + 32, String(args.content.length));
    assert.ok(args.content.startsWith('xxxx'));
    assert.equal(args.path, 'a.txt');
    const live = env.llmCalls[1].conversation.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.equal(JSON.parse(live.tool_calls[0].function.arguments).content, big);
  });

  await check('other user cannot resume -> 404 proposal_expired', async () => {
    const env = makeEnv({ rounds: [round(tc('w1', 'ws_write', { path: 'a.txt', content: 'x' }))] });
    await send(env);
    await assert.rejects(
      resume(env, { callId: 'w1', approved: true }, fakeReq({ ...ADMIN, userId: oid().toString() })),
      (err) => err.getStatus() === 404 && err.getResponse().error === 'proposal_expired',
    );
    assert.ok(!fs.existsSync(env.f('a.txt')));
  });

  const silentEnd = [{ type: 'finish', reason: 'stop' }];

  await check('ws_* tool_result carries the stored result live (exec output + exit code)', async () => {
    const env = makeEnv({ agentMode: 'direct', rounds: [round(tc('x1', 'ws_exec', { command: 'npm test' }))] });
    env.fake.switches.execScript = { code: 3, stdout: 'hello out', stderr: 'bad' };
    const res = await send(env);
    const [result] = ofType(res, 'tool_result').filter((e) => e.id === 'x1');
    assert.ok(result && typeof result.result === 'string', JSON.stringify(res.events));
    const parsed = JSON.parse(result.result);
    assert.equal(parsed.exitCode, 3);
    assert.equal(parsed.stdout, 'hello out');
    assert.equal(parsed.stderr, 'bad');
    const stored = env.appended.find((m) => m.role === 'assistant').toolCalls.find((t) => t.id === 'x1');
    assert.equal(result.result, stored.result);
  });

  await check('non-ws tool_result carries no result field (main chat unchanged)', async () => {
    const env = makeEnv({ agentMode: 'direct', rounds: [round(tc('l1', 'todo_list', {}))] });
    const res = await send(env);
    const [result] = ofType(res, 'tool_result').filter((e) => e.id === 'l1');
    assert.ok(result);
    assert.equal('result' in result, false);
  });

  await check('IDE turn with tool calls but no text is stored (send)', async () => {
    const env = makeEnv({ agentMode: 'direct', rounds: [round(tc('w1', 'ws_write', { path: 'a.txt', content: 'x' })), silentEnd] });
    await send(env);
    const assistant = env.appended.find((m) => m.role === 'assistant');
    assert.ok(assistant, JSON.stringify(env.appended));
    assert.equal(assistant.content, '');
    assert.deepEqual(assistant.toolCalls.map((t) => t.id), ['w1']);
  });

  await check('IDE turn with tool calls but no text is stored (resume)', async () => {
    const env = makeEnv({ rounds: [round(tc('w1', 'ws_write', { path: 'a.txt', content: 'x' })), silentEnd] });
    await send(env);
    assert.equal(env.appended.filter((m) => m.role === 'assistant').length, 0);
    await resume(env, { callId: 'w1', approved: true });
    const assistant = env.appended.find((m) => m.role === 'assistant');
    assert.ok(assistant, JSON.stringify(env.appended));
    assert.equal(assistant.content, '');
    assert.deepEqual(assistant.toolCalls.map((t) => t.id), ['w1']);
  });

  await check('non-IDE turn with tool calls but no text stays unstored (unchanged)', async () => {
    const env = makeEnv({ ide: false, rounds: [round(tc('l1', 'todo_list', {})), silentEnd] });
    await send(env);
    assert.equal(env.appended.filter((m) => m.role === 'assistant').length, 0);
  });
}

(async () => {
  try {
    await main();
  } finally {
    for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
  }
  console.log(`\n${total - failures}/${total} passed`);
  if (failures) process.exit(1);
})();
