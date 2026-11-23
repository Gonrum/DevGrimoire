#!/usr/bin/env node
/*
 * Workspace agent chat, data model (Task 1): agentMode, agent-allow list,
 * workspace-bound chat sessions. Loads from dist/ (run `npm run build` first).
 * No database: Mongo filters of the fakes are evaluated with `sift`.
 */
const path = require('node:path');
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
const sift = nm('sift').default || nm('sift');
const mongoose = nm('mongoose');
const { validate } = nm('class-validator');
const { plainToInstance } = nm('class-transformer');

const { WorkspacesService } = loadCompiled('workspaces/workspaces.service.js');
const { WorkspacesController } = loadCompiled('workspaces/workspaces.controller.js');
const { UpdateWorkspaceDto } = loadCompiled('workspaces/dto/update-workspace.dto.js');
const { SHELL_CONTROL_PATTERN, hasShellControl } = loadCompiled('workspaces/agent-allow.js');
const { WorkspaceSchema } = loadCompiled('workspaces/schemas/workspace.schema.js');
const { ChatSessionSchema } = loadCompiled('chat/schemas/chat-session.schema.js');
const { CreateChatSessionDto } = loadCompiled('chat/dto/chat.dto.js');
const { ChatService } = loadCompiled('chat/chat.service.js');
const { RequestContext } = loadCompiled('common/request-context.js');

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}
const statusOf = (e) => (typeof e.getStatus === 'function' ? e.getStatus() : e.status);
const rejectsWith = async (fn, status) => {
  let err;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected a rejection');
  assert.equal(statusOf(err), status, `status ${statusOf(err)}: ${err.message}`);
};
const oid = () => new mongoose.Types.ObjectId();
const PROJECT = oid();
const OTHER_PROJECT = oid();

// ---- fakes -------------------------------------------------------------------

function makeWorkspace(over = {}) {
  const ws = {
    _id: oid(), projectId: PROJECT, name: 'w', location: 'container', agentMode: 'confirm', agentAllow: [], ...over,
    toJSON() { const rest = { ...this }; delete rest.toJSON; return rest; },
  };
  return ws;
}
function makeWsModel(docs) {
  const find = (id) => docs.find((d) => String(d._id) === String(id)) || null;
  return {
    findById: (id) => ({ exec: async () => find(id) }),
    findOneAndUpdate: (filter, update) => ({
      exec: async () => {
        const doc = docs.find((d) => sift(filter)(d));
        if (!doc) return null;
        if (update.$push) for (const [k, v] of Object.entries(update.$push)) doc[k].push({ _id: oid(), ...v });
        return doc;
      },
    }),
    updateOne: (filter, update) => ({
      exec: async () => {
        const doc = docs.find((d) => d.agentAllow.some((e) => String(e._id) === String(filter['agentAllow._id'])));
        if (!doc || String(doc._id) !== String(filter._id)) return { modifiedCount: 0 };
        doc.agentAllow = doc.agentAllow.filter((e) => String(e._id) !== String(update.$pull.agentAllow._id));
        return { modifiedCount: 1 };
      },
    }),
    findByIdAndUpdate: (id, upd) => ({ exec: async () => { const d = find(id); if (d) Object.assign(d, upd); return d; } }),
  };
}
const events = { emit() {} };
const wsService = (docs) => new WorkspacesService(makeWsModel(docs), events, {});

function makeChatModel() {
  const store = [];
  return {
    store,
    create: async (d) => { const s = { _id: oid(), title: 't', createdAt: new Date(), ...d }; store.push(s); return s; },
    find: (filter) => {
      const chain = { sort: () => chain, skip: () => chain, limit: () => chain, exec: async () => store.filter(sift(filter)) };
      return chain;
    },
  };
}
const chatService = (ws, model = makeChatModel()) => ({ model, svc: new ChatService(model, {}, events, ws) });
const USER = oid().toString();

(async () => {
  // ---- agent-allow
  const entryOf = (ws, kind) => ws.agentAllow.filter((e) => e.kind === kind);

  await check('add file-kind rules; duplicate is not stored twice', async () => {
    const ws = makeWorkspace();
    const svc = wsService([ws]);
    await svc.addAgentAllow(String(ws._id), { kind: 'files.write' });
    await svc.addAgentAllow(String(ws._id), { kind: 'files.write' });
    await svc.addAgentAllow(String(ws._id), { kind: 'files.delete' });
    assert.equal(entryOf(ws, 'files.write').length, 1);
    assert.equal(ws.agentAllow.length, 2);
    assert.ok(ws.agentAllow[0]._id && ws.agentAllow[0].createdAt instanceof Date);
  });
  await check('command rules: trimmed; same kind+match+value is a duplicate, other match is not', async () => {
    const ws = makeWorkspace();
    const svc = wsService([ws]);
    await svc.addAgentAllow(String(ws._id), { kind: 'command', match: 'exact', value: '  npm test ' });
    await svc.addAgentAllow(String(ws._id), { kind: 'command', match: 'exact', value: 'npm test' });
    await svc.addAgentAllow(String(ws._id), { kind: 'command', match: 'prefix', value: 'npm test' });
    assert.equal(ws.agentAllow.length, 2);
    assert.equal(ws.agentAllow[0].value, 'npm test');
  });
  await check('101st distinct rule -> 400, a duplicate at the cap is still fine', async () => {
    const ws = makeWorkspace();
    const svc = wsService([ws]);
    for (let i = 0; i < 100; i += 1) await svc.addAgentAllow(String(ws._id), { kind: 'command', match: 'exact', value: `c${i}` });
    assert.equal(ws.agentAllow.length, 100);
    await rejectsWith(() => svc.addAgentAllow(String(ws._id), { kind: 'command', match: 'exact', value: 'c-new' }), 400);
    await svc.addAgentAllow(String(ws._id), { kind: 'command', match: 'exact', value: 'c5' });
    assert.equal(ws.agentAllow.length, 100);
  });
  for (const ctl of [';', '&&', '||', '|', '`', '$(', '>', '<', '&', '\n', '\r']) {
    await check(`prefix containing ${JSON.stringify(ctl)} -> 400 (exact is allowed)`, async () => {
      const ws = makeWorkspace();
      const svc = wsService([ws]);
      assert.ok(SHELL_CONTROL_PATTERN.test(`a${ctl}b`) && hasShellControl(`a${ctl}b`));
      await rejectsWith(() => svc.addAgentAllow(String(ws._id), { kind: 'command', match: 'prefix', value: `echo a${ctl}b` }), 400);
      await svc.addAgentAllow(String(ws._id), { kind: 'command', match: 'exact', value: `echo a${ctl}b` });
      assert.equal(ws.agentAllow.length, 1);
    });
  }
  await check('invalid input -> 400 (kind, match, value empty/too long/non-string)', async () => {
    const ws = makeWorkspace();
    const svc = wsService([ws]);
    const id = String(ws._id);
    for (const bad of [
      { kind: 'nope' }, {}, { kind: 'command', match: 'glob', value: 'x' }, { kind: 'command', match: 'exact' },
      { kind: 'command', match: 'exact', value: '   ' }, { kind: 'command', match: 'exact', value: 'a'.repeat(501) },
      { kind: 'command', match: 'exact', value: 5 },
    ]) await rejectsWith(() => svc.addAgentAllow(id, bad), 400);
    await svc.addAgentAllow(id, { kind: 'command', match: 'exact', value: 'a'.repeat(500) });
    assert.equal(ws.agentAllow.length, 1);
  });
  await check('remove: deletes the entry; unknown / malformed entry id and unknown workspace -> 404', async () => {
    const ws = makeWorkspace();
    const svc = wsService([ws]);
    await svc.addAgentAllow(String(ws._id), { kind: 'files.structure' });
    const entryId = String(ws.agentAllow[0]._id);
    await rejectsWith(() => svc.removeAgentAllow(String(ws._id), String(oid())), 404);
    await rejectsWith(() => svc.removeAgentAllow(String(ws._id), 'not-an-id'), 404);
    await rejectsWith(() => svc.removeAgentAllow(String(oid()), entryId), 404);
    await svc.removeAgentAllow(String(ws._id), entryId);
    assert.equal(ws.agentAllow.length, 0);
    await rejectsWith(() => svc.removeAgentAllow(String(ws._id), entryId), 404);
  });
  await check('agent-allow respects project access of the actor (403)', async () => {
    const ws = makeWorkspace();
    const svc = wsService([ws]);
    const actor = { userId: 'u', username: 'u', role: 'user', projectScopeMode: 'selected', allowedProjectIds: [] };
    await rejectsWith(() => RequestContext.run(actor, undefined, () => svc.addAgentAllow(String(ws._id), { kind: 'files.write' })), 403);
    await rejectsWith(() => RequestContext.run(actor, undefined, () => svc.removeAgentAllow(String(ws._id), String(oid()))), 403);
  });

  // ---- agentMode
  await check('update DTO: agentMode direct/confirm valid, yolo invalid', async () => {
    for (const m of ['direct', 'confirm']) assert.equal((await validate(plainToInstance(UpdateWorkspaceDto, { agentMode: m }))).length, 0);
    assert.ok((await validate(plainToInstance(UpdateWorkspaceDto, { agentMode: 'yolo' }))).length >= 1);
  });
  await check('update with agentMode direct is stored', async () => {
    const ws = makeWorkspace();
    const svc = wsService([ws]);
    await svc.update(String(ws._id), { agentMode: 'direct' });
    assert.equal(ws.agentMode, 'direct');
  });
  await check('schema defaults: agentMode confirm, agentAllow []; chat ideAgent false', () => {
    assert.equal(WorkspaceSchema.path('agentMode').options.default, 'confirm');
    assert.equal(WorkspaceSchema.path('agentAllow').options.default.length, 0);
    assert.equal(ChatSessionSchema.path('ideAgent').options.default, false);
    assert.ok(ChatSessionSchema.indexes().some(([k]) => k.userId === 1 && k.workspaceId === 1 && k.updatedAt === -1));
  });
  await check('controller responses carry agentMode (legacy -> confirm) and agentAllow; add/remove routes', async () => {
    const legacy = { _id: oid(), projectId: PROJECT, name: 'l', location: 'container', toJSON() { return { _id: this._id, name: 'l' }; } };
    const ws = makeWorkspace({ agentMode: 'direct' });
    const svc = wsService([ws]);
    svc.findByProject = async () => [legacy, ws];
    const ctrl = new WorkspacesController(svc, {}, {}, {}, {}, {}, { findManyByIds: async () => [] });
    const list = await ctrl.findAll(PROJECT.toString());
    assert.equal(list[0].agentMode, 'confirm');
    assert.deepEqual(list[0].agentAllow, []);
    assert.equal(list[1].agentMode, 'direct');
    const out = await ctrl.addAgentAllow(String(ws._id), { kind: 'files.write' });
    assert.equal(out.agentAllow.length, 1);
    await ctrl.removeAgentAllow(String(ws._id), String(out.agentAllow[0]._id));
    assert.equal(ws.agentAllow.length, 0);
    assert.equal((await ctrl.update(String(ws._id), { agentMode: 'confirm' })).agentMode, 'confirm');
  });

  // ---- chat sessions
  await check('create DTO accepts workspaceId/ideAgent, rejects malformed', async () => {
    assert.equal((await validate(plainToInstance(CreateChatSessionDto, { projectId: String(PROJECT), workspaceId: String(oid()), ideAgent: true }))).length, 0);
    assert.ok((await validate(plainToInstance(CreateChatSessionDto, { workspaceId: 'x', ideAgent: 'yes' }))).length >= 2);
  });
  await check('create ideAgent without workspaceId / without projectId -> 400', async () => {
    const { svc } = chatService(wsService([makeWorkspace()]));
    await rejectsWith(() => svc.createSession({ projectId: String(PROJECT) }, USER, 't', { ideAgent: true }), 400);
    await rejectsWith(() => svc.createSession({ customerId: String(oid()) }, USER, 't', { ideAgent: true, workspaceId: String(oid()) }), 400);
  });
  await check('create workspaceId without ideAgent -> 400', async () => {
    const { svc } = chatService(wsService([makeWorkspace()]));
    await rejectsWith(() => svc.createSession({ projectId: String(PROJECT) }, USER, 't', { workspaceId: String(oid()) }), 400);
  });
  await check('create ideAgent with a workspace of another project -> 400; unknown -> 404', async () => {
    const foreign = makeWorkspace({ projectId: OTHER_PROJECT });
    const { svc, model } = chatService(wsService([foreign]));
    await rejectsWith(() => svc.createSession({ projectId: String(PROJECT) }, USER, 't', { ideAgent: true, workspaceId: String(foreign._id) }), 400);
    await rejectsWith(() => svc.createSession({ projectId: String(PROJECT) }, USER, 't', { ideAgent: true, workspaceId: String(oid()) }), 404);
    assert.equal(model.store.length, 0);
  });
  await check('create ideAgent without project access -> 403', async () => {
    const ws = makeWorkspace();
    const { svc } = chatService(wsService([ws]));
    const actor = { userId: 'u', username: 'u', role: 'user', projectScopeMode: 'selected', allowedProjectIds: [] };
    await assert.rejects(() => RequestContext.run(actor, undefined, () => svc.createSession({ projectId: String(PROJECT) }, USER, 't', { ideAgent: true, workspaceId: String(ws._id) })));
  });
  await check('create ideAgent with own workspace stores workspaceId + ideAgent', async () => {
    const ws = makeWorkspace();
    const { svc } = chatService(wsService([ws]));
    const s = await svc.createSession({ projectId: String(PROJECT) }, USER, 't', { ideAgent: true, workspaceId: String(ws._id) });
    assert.equal(s.ideAgent, true);
    assert.equal(String(s.workspaceId), String(ws._id));
  });
  await check('list: without workspaceId hides ideAgent sessions; with it only that workspace', async () => {
    const wsA = makeWorkspace(), wsB = makeWorkspace();
    const { svc, model } = chatService(wsService([wsA, wsB]));
    const plain = await svc.createSession({ projectId: String(PROJECT) }, USER, 'plain');
    assert.equal(plain.ideAgent, undefined);
    const a = await svc.createSession({ projectId: String(PROJECT) }, USER, 'a', { ideAgent: true, workspaceId: String(wsA._id) });
    await svc.createSession({ projectId: String(PROJECT) }, USER, 'b', { ideAgent: true, workspaceId: String(wsB._id) });
    // legacy document: no ideAgent field at all
    model.store.push({ _id: oid(), title: 'legacy', userId: USER, projectId: String(PROJECT) });
    const dock = await svc.listSessions({ projectId: String(PROJECT) }, USER);
    assert.deepEqual(dock.map((s) => s.title).sort(), ['legacy', 'plain']);
    const forA = await svc.listSessions({ projectId: String(PROJECT) }, USER, { workspaceId: String(wsA._id) });
    assert.deepEqual(forA.map((s) => String(s._id)), [String(a._id)]);
    await rejectsWith(() => svc.listSessions({ projectId: String(PROJECT) }, USER, { workspaceId: 'zzz' }), 400);
    await rejectsWith(() => svc.listSessions({ customerId: String(oid()) }, USER, { workspaceId: String(wsA._id) }), 400);
  });

  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
})();
