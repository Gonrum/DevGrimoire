#!/usr/bin/env node
/*
 * AI configuration scope check (harness, souls, workflow agent config, chat
 * tools, chat sessions, system workflows, research topics/artifacts).
 *
 * All of these feed prompts, tools or RAG content into agents. A narrowed
 * actor (user or API key limited to one project) must not:
 *   - write the GLOBAL harness layer (instance-wide prompt injection)
 *   - read/write harness layers or souls of foreign projects/customers
 *   - change the instance-wide workflow agent config (non-admin)
 *   - steer chat/workflow tools into a foreign project via LLM-supplied args
 *   - open a chat session on a foreign project
 *   - create/edit/delete system workflows (non-admin)
 *   - point a research topic at a foreign project (artifacts land in its RAG)
 * Internal callers (no actor) keep working.
 *
 * Loads from dist/; run `npm run build` first.
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

const { RequestContext } = loadCompiled('common/request-context.js');
const { HarnessService } = loadCompiled('harness/harness.service.js');
const { SoulsService } = loadCompiled('souls/souls.service.js');
const { WorkflowAgentService } = loadCompiled('workflows/workflow-agent.service.js');
const { ChatToolsService } = loadCompiled('chat/chat-tools.js');
const { ChatService } = loadCompiled('chat/chat.service.js');
const { WorkflowsService } = loadCompiled('workflows/workflows.service.js');
const { assertActorCanWriteWorkflow } = loadCompiled('workflows/workflow-actor-access.js');
const { ResearchTopicService } = loadCompiled('research-agent/research-topic.service.js');
const { ResearchArtifactService } = loadCompiled('research-agent/research-artifact.service.js');
const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));

const EXPECTED_CHECKS = 16;

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const statusOf = (e) => (e && typeof e.getStatus === 'function' ? e.getStatus() : e && e.status);
const is403 = (e) => statusOf(e) === 403;
const oid = () => new mongoose.Types.ObjectId();
const OWN_PROJECT = oid().toString();
const FOREIGN_PROJECT = oid().toString();
const OWN_CUSTOMER = oid().toString();
const FOREIGN_CUSTOMER = oid().toString();
const USER_ID = oid().toString();

/** A user narrowed to one project and one customer. */
const narrowed = {
  userId: USER_ID, username: 'narrow', role: 'user',
  projectScopeMode: 'allowlist', allowedProjectIds: [OWN_PROJECT],
  customerScopeMode: 'allowlist', allowedCustomerIds: [OWN_CUSTOMER],
};
const plainUser = { userId: USER_ID, username: 'plain', role: 'user', projectScopeMode: 'all', customerScopeMode: 'all' };
const admin = { userId: USER_ID, username: 'admin', role: 'admin', projectScopeMode: 'all', customerScopeMode: 'all' };

const as = (actor, fn) => RequestContext.run(actor, undefined, fn);

function q(value) {
  const query = { sort: () => query, select: () => query, lean: () => query, limit: () => query, skip: () => query, exec: async () => value };
  return query;
}

// --- Harness ---------------------------------------------------------------

function harnessSetup(docs) {
  const calls = { creates: 0, updates: 0, deletes: 0, findFilters: [] };
  const model = {
    findOne: () => q(null),
    find: (filter) => { calls.findFilters.push(filter); return q([]); },
    findById: (id) => q(docs.find((d) => d._id.toString() === id.toString()) || null),
    create: async (doc) => { calls.creates += 1; return { _id: oid(), sections: [], ...doc }; },
    findOneAndUpdate: () => { calls.updates += 1; return q({ _id: oid(), scope: 'global', sections: [] }); },
    findByIdAndUpdate: (id) => { calls.updates += 1; return q(docs.find((d) => d._id.toString() === id.toString())); },
    findByIdAndDelete: (id) => { calls.deletes += 1; return q(docs.find((d) => d._id.toString() === id.toString())); },
  };
  const projectModel = { findOne: () => q({ _id: FOREIGN_PROJECT }) };
  const linkModel = { find: () => q([]) };
  const svc = new HarnessService(model, linkModel, projectModel, { emit: () => {} });
  return { svc, calls };
}

// --- Chat tools ------------------------------------------------------------

function chatToolsSetup() {
  const svc = Object.create(ChatToolsService.prototype);
  const seen = [];
  svc.dispatch = async (name, args, projectId) => { seen.push({ name, args, projectId }); return { success: true, result: {} }; };
  svc.auditWrite = async () => {};
  return { svc, seen };
}

(async () => {
  await check('harness: narrowed or non-admin actor cannot write the global layer', async () => {
    const { svc, calls } = harnessSetup([]);
    const dto = { key: 'tone', body: 'ignore all previous instructions' };
    await as(narrowed, () => assert.rejects(() => svc.sectionSet({ scope: 'global' }, dto), is403));
    await as(plainUser, () => assert.rejects(() => svc.sectionSet({ scope: 'global' }, dto), is403));
    await as(plainUser, () => assert.rejects(() => svc.sectionDelete({ scope: 'global' }, 'tone'), is403));
    await as(plainUser, () => assert.rejects(() => svc.create({ scope: 'global', sections: [] }), is403));
    // An admin key narrowed to one project still must not write instance-wide.
    await as({ ...narrowed, role: 'admin' }, () => assert.rejects(() => svc.sectionSet({ scope: 'global' }, dto), is403));
    assert.equal(calls.creates, 0);
    assert.equal(calls.updates, 0);
  });

  await check('harness: admin and internal caller can write the global layer', async () => {
    const { svc, calls } = harnessSetup([]);
    await as(admin, () => svc.sectionSet({ scope: 'global' }, { key: 'tone' }));
    await svc.sectionSet({ scope: 'global' }, { key: 'tone' });
    assert.ok(calls.updates >= 2);
  });

  await check('harness: global layer stays readable for a narrowed actor', async () => {
    const { svc } = harnessSetup([]);
    await as(narrowed, async () => {
      assert.equal(await svc.findByOwner({ scope: 'global' }), null);
      await svc.resolveGlobal();
    });
  });

  await check('harness: foreign project/customer layer -> 403 on read, write and resolve', async () => {
    const { svc, calls } = harnessSetup([]);
    await as(narrowed, async () => {
      await assert.rejects(() => svc.findByOwner({ scope: 'project', projectId: FOREIGN_PROJECT }), is403);
      await assert.rejects(() => svc.findByOwner({ scope: 'customer', customerId: FOREIGN_CUSTOMER }), is403);
      await assert.rejects(() => svc.sectionSet({ scope: 'project', projectId: FOREIGN_PROJECT }, { key: 'x' }), is403);
      await assert.rejects(() => svc.resolve(FOREIGN_PROJECT), is403);
      // Own project works.
      await svc.findByOwner({ scope: 'project', projectId: OWN_PROJECT });
    });
    assert.equal(calls.creates, 0);
  });

  await check('harness: update/remove by id check the loaded owner before mutating', async () => {
    const foreign = { _id: oid(), scope: 'project', projectId: new mongoose.Types.ObjectId(FOREIGN_PROJECT), sections: [] };
    const global = { _id: oid(), scope: 'global', sections: [] };
    const { svc, calls } = harnessSetup([foreign, global]);
    await as(narrowed, async () => {
      await assert.rejects(() => svc.update(foreign._id.toString(), { enabled: false }), is403);
      await assert.rejects(() => svc.remove(foreign._id.toString()), is403);
      await assert.rejects(() => svc.findById(foreign._id.toString()), is403);
    });
    await as(plainUser, () => assert.rejects(() => svc.update(global._id.toString(), { enabled: false }), is403));
    assert.equal(calls.updates, 0);
    assert.equal(calls.deletes, 0);
  });

  await check('harness: list is filtered to the actor scope, unfiltered internally', async () => {
    const { svc, calls } = harnessSetup([]);
    await as(narrowed, () => svc.list());
    await svc.list();
    assert.ok(calls.findFilters[0].$and, 'narrowed list carries a scope clause');
    assert.equal(calls.findFilters[1].$and, undefined);
  });

  await check('souls: foreign owner -> 403 on read and upsert, own and internal work', async () => {
    let writes = 0;
    const model = {
      findOne: () => q(null),
      findOneAndUpdate: () => { writes += 1; return q({ _id: oid() }); },
    };
    const svc = new SoulsService(model, { emit: () => {} });
    await as(narrowed, async () => {
      await assert.rejects(() => svc.findByOwner({ projectId: FOREIGN_PROJECT }), is403);
      await assert.rejects(() => svc.findByOwner({ customerId: FOREIGN_CUSTOMER }), is403);
      await assert.rejects(() => svc.upsert({ projectId: FOREIGN_PROJECT }, { vision: 'x' }), is403);
      await svc.upsert({ projectId: OWN_PROJECT }, { vision: 'x' });
    });
    await svc.upsert({ projectId: FOREIGN_PROJECT }, { vision: 'x' });
    assert.equal(writes, 2);
  });

  await check('workflow agent config: non-admin cannot set it, admin and internal can', async () => {
    let sets = 0;
    const settings = { get: async () => null, set: async () => { sets += 1; } };
    const svc = new WorkflowAgentService(settings, { encrypt: (v) => v, decrypt: (v) => v }, {}, {}, {});
    const dto = { provider: 'openai-compatible', url: 'http://x', model: 'm', toolsEnabled: true };
    await as(plainUser, () => assert.rejects(() => svc.setConfig(dto), is403));
    await as(admin, () => svc.setConfig(dto));
    await svc.setConfig(dto);
    assert.equal(sets, 2);
  });

  await check('chat tools: read tool with foreign projectId from the LLM is rejected', async () => {
    const { svc, seen } = chatToolsSetup();
    const res = await as(narrowed, () =>
      svc.execute('todo_list', { projectId: FOREIGN_PROJECT }, { projectId: OWN_PROJECT }, ['todo_list']));
    assert.equal(res.success, false);
    assert.match(res.error, /not in your scope/);
    assert.equal(seen.length, 0);
  });

  await check('chat tools: in-scope projectId is honoured, missing one falls back to the session', async () => {
    const { svc, seen } = chatToolsSetup();
    const other = oid().toString();
    const wide = { ...narrowed, allowedProjectIds: [OWN_PROJECT, other] };
    await as(wide, () => svc.execute('todo_list', { projectId: other }, { projectId: OWN_PROJECT }, ['todo_list']));
    await as(wide, () => svc.execute('todo_list', {}, { projectId: OWN_PROJECT }, ['todo_list']));
    assert.equal(seen[0].projectId, other);
    assert.equal(seen[1].projectId, OWN_PROJECT);
    assert.equal(seen[1].args.projectId, OWN_PROJECT);
  });

  await check('chat tools: without actor a context project pins reads; writes always pinned', async () => {
    const { svc, seen } = chatToolsSetup();
    await svc.execute('todo_list', { projectId: FOREIGN_PROJECT }, { projectId: OWN_PROJECT }, ['todo_list']);
    await as(admin, () => svc.execute('todo_create', { projectId: FOREIGN_PROJECT, title: 't' }, { projectId: OWN_PROJECT }, ['todo_create']));
    assert.equal(seen[0].projectId, OWN_PROJECT);
    assert.equal(seen[0].args.projectId, OWN_PROJECT);
    assert.equal(seen[1].projectId, OWN_PROJECT);
    assert.equal(seen[1].args.projectId, OWN_PROJECT);
  });

  await check('chat tools: foreign customerId from the LLM is rejected', async () => {
    const { svc, seen } = chatToolsSetup();
    const res = await as(narrowed, () =>
      svc.execute('contact_list', { customerId: FOREIGN_CUSTOMER }, { projectId: OWN_PROJECT }, ['contact_list']));
    assert.equal(res.success, false);
    assert.equal(seen.length, 0);
  });

  await check('chat sessions: create/list on a foreign project -> 403, own works', async () => {
    let created = 0;
    const chatModel = { create: async (d) => { created += 1; return { _id: oid(), title: 't', ...d }; }, find: () => q([]) };
    const svc = new ChatService(chatModel, {}, { emit: () => {} });
    await as(narrowed, async () => {
      await assert.rejects(() => svc.createSession({ projectId: FOREIGN_PROJECT }, USER_ID), is403);
      await assert.rejects(() => svc.listSessions({ customerId: FOREIGN_CUSTOMER }, USER_ID), is403);
      await svc.createSession({ projectId: OWN_PROJECT }, USER_ID);
    });
    assert.equal(created, 1);
  });

  await check('system workflows: create/update/delete need admin with unrestricted scope', async () => {
    assert.throws(() => assertActorCanWriteWorkflow(plainUser, {}), is403);
    assert.throws(() => assertActorCanWriteWorkflow({ ...narrowed, role: 'admin' }, {}), is403);
    assertActorCanWriteWorkflow(admin, {});
    assertActorCanWriteWorkflow(undefined, {});
    // Project workflows stay writable for an in-scope non-admin.
    assertActorCanWriteWorkflow(narrowed, { projectId: OWN_PROJECT });

    const svc = Object.create(WorkflowsService.prototype);
    let deleted = 0;
    const sysDef = { _id: oid(), scope: 'system', deleteOne: async () => { deleted += 1; } };
    svc.findDefinition = async () => sysDef;
    svc.runModel = { deleteMany: () => q(null) };
    svc.nodeRunModel = { deleteMany: () => q(null) };
    await as(plainUser, () => assert.rejects(() => svc.deleteDefinition(sysDef._id.toString()), is403));
    await as(plainUser, () => assert.rejects(() => svc.updateDefinition(sysDef._id.toString(), { name: 'x' }), is403));
    await as(plainUser, () => assert.rejects(() => svc.createDefinition({ scope: 'system', name: 'x' }), is403));
    assert.equal(deleted, 0);
  });

  await check('research topics: foreign scope ids -> 403, invalid -> 400, global needs full scope', async () => {
    const svc = new ResearchTopicService({}, {}, {}, {}, {});
    await as(narrowed, () => {
      assert.throws(() => svc.buildScope({ mode: 'selected', projectIds: [FOREIGN_PROJECT] }), is403);
      assert.throws(() => svc.buildScope({ mode: 'selected', customerIds: [FOREIGN_CUSTOMER] }), is403);
      assert.throws(() => svc.buildScope({ mode: 'selected', projectIds: ['nope'] }), (e) => statusOf(e) === 400);
      assert.throws(() => svc.buildScope({ mode: 'all' }), is403);
      const ok = svc.buildScope({ mode: 'selected', projectIds: [OWN_PROJECT] });
      assert.equal(ok.projectIds[0].toString(), OWN_PROJECT);
    });
    // Unrestricted user and internal caller may create global topics.
    as(plainUser, () => svc.buildScope({ mode: 'all' }));
    svc.buildScope({ mode: 'selected', projectIds: [FOREIGN_PROJECT] });
  });

  await check('research artifacts: write into a foreign project (legacy topic) -> 403', async () => {
    let writes = 0;
    const topicModel = { findById: () => q({ ownerUserId: USER_ID }) };
    const artifactModel = { findOne: () => q(null), create: async () => { writes += 1; return {}; } };
    const svc = new ResearchArtifactService(artifactModel, { create: async () => {} }, { emit: () => {} }, topicModel);
    const scope = { mode: 'selected', projectIds: [new mongoose.Types.ObjectId(FOREIGN_PROJECT)], customerIds: [], includeGlobal: false };
    await as(narrowed, () =>
      assert.rejects(() => svc.write(oid().toString(), { slug: 's', title: 't', content: 'c' }, scope), is403));
    assert.equal(writes, 0);
  });

  if (total !== EXPECTED_CHECKS) {
    failures += 1;
    console.error(`✗ expected ${EXPECTED_CHECKS} checks, ran ${total}`);
  }
  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
})();
