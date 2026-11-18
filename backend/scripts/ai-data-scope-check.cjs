#!/usr/bin/env node
/*
 * ai-data scope check — oracle, doc-update proposals, validation reports,
 * questions, recurring tasks, logs and note promotion.
 *
 * Every service used to load by id / list / create without looking at the
 * caller's project/customer scope. This check pins the fix with in-memory
 * fakes and a narrowed actor (`RequestContext.run(actor, …)`):
 *   - by-id access to a foreign entity -> 403, nothing mutated
 *   - lists without an owner param carry the scope filter
 *   - creates into a foreign owner -> 403
 *   - recurring tasks: owner is always the actor, system tasks need admin,
 *     chat tasks only by their owner, the scheduler runs as the owner and
 *     skips tasks whose owner is inactive
 *   - logs: /logs/batch body is validated per entry
 *   - internal callers (no actor) keep working
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
const { OracleService } = loadCompiled('oracle/oracle.service.js');
const { DocUpdateProposalsService } = loadCompiled('doc-update-proposals/doc-update-proposals.service.js');
const { ValidationReportsService } = loadCompiled('validation-reports/validation-reports.service.js');
const { QuestionsService } = loadCompiled('questions/questions.service.js');
const { RecurringTasksService } = loadCompiled('recurring-tasks/recurring-tasks.service.js');
const { CreateRecurringTaskDto } = loadCompiled('recurring-tasks/dto/create-recurring-task.dto.js');
const { LogsService } = loadCompiled('logs/logs.service.js');
const { CreateLogBatchDto } = loadCompiled('logs/dto/create-log-batch.dto.js');
const { NotesPromotionService } = loadCompiled('notes/notes-promotion.service.js');
const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));
const { plainToInstance } = require(path.resolve(__dirname, '..', 'node_modules', 'class-transformer'));
const { validate } = require(path.resolve(__dirname, '..', 'node_modules', 'class-validator'));

let failures = 0, total = 0;
async function check(label, fn) {
  total += 1;
  try { await fn(); console.log(`✓ ${label}`); }
  catch (err) { failures += 1; console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`); }
}

const statusOf = (e) => (e && typeof e.getStatus === 'function' ? e.getStatus() : e && e.status);
const oid = () => new mongoose.Types.ObjectId();
const OID = (s) => new mongoose.Types.ObjectId(s);
const OWN = oid().toString();
const FOREIGN = oid().toString();
const FOREIGN_CUSTOMER = oid().toString();
const USER_ID = oid().toString();
const OTHER_USER_ID = oid().toString();

/** Narrowed actor: one project, no customers. */
const narrowed = {
  userId: USER_ID, username: 'narrow', role: 'user', permissions: [],
  projectScopeMode: 'allowlist', allowedProjectIds: [OWN],
  customerScopeMode: 'allowlist', allowedCustomerIds: [],
};
const asNarrowed = (fn) => RequestContext.run(narrowed, undefined, fn);

async function expect403(fn) {
  let err;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected a 403, call succeeded');
  assert.equal(statusOf(err), 403, `expected 403, got ${statusOf(err)}: ${err.message}`);
}

const q = (value) => ({
  exec: async () => value,
  sort() { return this; }, skip() { return this; }, limit() { return this; },
  select() { return this; }, lean() { return this; },
});

/** Minimal model: a doc store keyed by id, records find filters and writes. */
function fakeModel(docs = []) {
  const calls = { finds: [], deletes: 0, updates: 0, creates: [] };
  const byId = (id) => docs.find((d) => d._id.toString() === String(id)) || null;
  return {
    calls,
    findById: (id) => q(byId(id)),
    findOne: (f) => { calls.finds.push(f); return q(null); },
    find: (f) => { calls.finds.push(f); return q([]); },
    countDocuments: (f) => { calls.finds.push(f); return q(0); },
    findByIdAndDelete: (id) => { calls.deletes += 1; return q(byId(id)); },
    deleteOne: () => { calls.deletes += 1; return q({}); },
    updateOne: () => { calls.updates += 1; return q({}); },
    findByIdAndUpdate: (id, u) => { calls.updates += 1; calls.lastUpdate = u; return q(byId(id)); },
    findOneAndUpdate: (f) => { calls.updates += 1; return q(byId(f._id)); },
    create: async (d) => { calls.creates.push(d); return { _id: oid(), ...d, projectId: d.projectId }; },
    insertMany: async (d) => { calls.creates.push(...d); return d; },
    aggregate: async () => [],
  };
}
const emitter = { emit() {} };
const hasScopeClause = (f) => JSON.stringify(f).includes(OWN);

(async () => {
  // ---------------------------------------------------------------- oracle
  const foreignSuggestion = { _id: oid(), projectId: OID(FOREIGN), status: 'open', affectedEntities: [], save: async () => {} };
  const ownSuggestion = { _id: oid(), projectId: OID(OWN), status: 'open', affectedEntities: [], save: async () => {} };
  const suggestionModel = fakeModel([foreignSuggestion, ownSuggestion]);
  const oracle = new OracleService(suggestionModel, fakeModel(), fakeModel(), fakeModel(), {}, emitter);

  await check('oracle: foreign suggestion by id / status / delete -> 403, nothing deleted', async () => {
    const id = foreignSuggestion._id.toString();
    await asNarrowed(() => expect403(() => oracle.findById(id)));
    await asNarrowed(() => expect403(() => oracle.updateStatus(id, 'dismissed')));
    await asNarrowed(() => expect403(() => oracle.remove(id)));
    await asNarrowed(() => expect403(() => oracle.analyze(FOREIGN)));
    assert.equal(suggestionModel.calls.deletes, 0);
  });
  await check('oracle: list without projectId is scope-filtered; own + internal still work', async () => {
    await asNarrowed(() => oracle.list({}));
    assert.ok(hasScopeClause(suggestionModel.calls.finds.at(-1)), 'no scope clause in list filter');
    await asNarrowed(() => expect403(() => oracle.list({ projectId: FOREIGN })));
    const own = await asNarrowed(() => oracle.findById(ownSuggestion._id.toString()));
    assert.equal(own, ownSuggestion);
    const internal = await oracle.findById(foreignSuggestion._id.toString());
    assert.equal(internal, foreignSuggestion);
  });

  // ------------------------------------------------- doc-update proposals
  const foreignProposal = { _id: oid(), projectId: OID(FOREIGN), status: 'open' };
  const proposalModel = fakeModel([foreignProposal]);
  const proposals = new DocUpdateProposalsService(proposalModel, fakeModel(), fakeModel(), {}, emitter);
  await check('doc proposals: foreign by id / status / create -> 403; list scope-filtered', async () => {
    const id = foreignProposal._id.toString();
    await asNarrowed(() => expect403(() => proposals.findById(id)));
    await asNarrowed(() => expect403(() => proposals.updateStatus(id, 'dismissed')));
    await asNarrowed(() => expect403(() => proposals.create({
      projectId: FOREIGN, source: { type: 'todo', id: 'x' }, target: { type: 'manual', title: 't' },
      reason: 'r', confidence: 1, suggestedChange: { mode: 'review_only', summary: 's' },
    })));
    assert.equal(proposalModel.calls.creates.length, 0);
    assert.equal(proposalModel.calls.updates, 0);
    await asNarrowed(() => proposals.list({}));
    assert.ok(hasScopeClause(proposalModel.calls.finds.at(-1)));
  });

  // --------------------------------------------------- validation reports
  const foreignReport = { _id: oid(), projectId: OID(FOREIGN), status: 'failed' };
  const reportModel = fakeModel([foreignReport]);
  const todoOtherProject = { _id: oid(), projectId: OID(oid().toString()) };
  const reports = new ValidationReportsService(reportModel, emitter, {
    findById: async () => todoOtherProject,
  });
  await check('validation reports: foreign by id / bug todo / create -> 403; list + latestForTodo scoped', async () => {
    const id = foreignReport._id.toString();
    await asNarrowed(() => expect403(() => reports.findById(id)));
    await asNarrowed(() => expect403(() => reports.proposeBugTodo(id)));
    await asNarrowed(() => expect403(() => reports.create({ projectId: FOREIGN, name: 'n', status: 'failed' })));
    await asNarrowed(() => reports.list({ todoId: oid().toString() }));
    assert.ok(hasScopeClause(reportModel.calls.finds.at(-1)), 'list by todoId must still be scoped');
    await asNarrowed(() => reports.latestForTodo(oid().toString()));
    assert.ok(hasScopeClause(reportModel.calls.finds.at(-1)), 'latestForTodo must be scoped');
  });
  await check('validation reports: todoId from another project -> 400', async () => {
    let err;
    try { await asNarrowed(() => reports.create({ projectId: OWN, todoId: todoOtherProject._id.toString(), name: 'n', status: 'failed' })); }
    catch (e) { err = e; }
    assert.equal(statusOf(err), 400);
    assert.equal(reportModel.calls.creates.length, 0);
  });

  // -------------------------------------------------------------- questions
  let saved = 0;
  const legacyForeignQuestion = {
    _id: oid(), projectId: OID(FOREIGN), direction: 'user_to_agent', status: 'pending',
    options: [], resolvedTargetUserIds: [], responses: [], question: 'q', save: async () => { saved += 1; },
  };
  const customerQuestion = {
    _id: oid(), projectId: OID(OWN), customerId: OID(FOREIGN_CUSTOMER), direction: 'agent_to_user',
    status: 'pending', options: [], resolvedTargetUserIds: [], responses: [], question: 'q', save: async () => { saved += 1; },
  };
  const questionModel = fakeModel([legacyForeignQuestion, customerQuestion]);
  const questions = new QuestionsService(questionModel, emitter, {}, {}, {}, {
    resolveQuestionTargets: async () => ({ userIds: [] }),
    findUserById: async () => null,
  }, { record: async () => {} });

  await check('questions: answering an untargeted foreign question -> 403, not saved', async () => {
    const id = legacyForeignQuestion._id.toString();
    await asNarrowed(() => expect403(() => questions.answer(id, 'do it', { userId: USER_ID })));
    await asNarrowed(() => expect403(() => questions.answer(id, 'do it', { byAgent: true })));
    await asNarrowed(() => expect403(() => questions.cancel(id)));
    await asNarrowed(() => expect403(() => questions.snooze(id, new Date(Date.now() + 60_000))));
    await asNarrowed(() => expect403(() => questions.convertToKnowledge(id, { topic: 't' })));
    await asNarrowed(() => expect403(() => questions.markAsDecision(id, { decision: 'd' })));
    await asNarrowed(() => expect403(() => questions.createFollowupTodo(id)));
    assert.equal(saved, 0);
  });
  await check('questions: relation question needs both axes (own project, foreign customer) -> 403', async () => {
    await asNarrowed(() => expect403(() => questions.findById(customerQuestion._id.toString())));
  });
  await check('questions: create into foreign project/customer -> 403', async () => {
    await asNarrowed(() => expect403(() => questions.create({ question: 'q', projectId: FOREIGN })));
    await asNarrowed(() => expect403(() => questions.create({ question: 'q', customerId: FOREIGN_CUSTOMER })));
    assert.equal(questionModel.calls.creates.length, 0);
  });
  await check('questions: findAll / findOpen / findPending / by-todo lists are scoped', async () => {
    await asNarrowed(() => questions.findAll({ q: 'secret' }));
    assert.ok(hasScopeClause(questionModel.calls.finds.at(-1)), 'findAll');
    await asNarrowed(() => expect403(() => questions.findAll({ projectId: FOREIGN })));
    await asNarrowed(() => questions.findOpen({}));
    assert.ok(hasScopeClause(questionModel.calls.finds.at(-1)), 'findOpen');
    await asNarrowed(() => questions.findPending(USER_ID, 'agent_to_user'));
    const pendingFilter = questionModel.calls.finds.at(-1);
    assert.ok(hasScopeClause(pendingFilter), 'findPending');
    assert.ok(JSON.stringify(pendingFilter).includes('expiresAt'), 'expiry clause must survive the scope merge');
    await asNarrowed(() => questions.findByTodo(oid().toString()));
    assert.ok(hasScopeClause(questionModel.calls.finds.at(-1)), 'findByTodo');
    await asNarrowed(() => questions.findOpenForTodos([oid().toString()]));
    assert.ok(hasScopeClause(questionModel.calls.finds.at(-1)), 'findOpenForTodos');
  });
  await check('questions: internal caller (no actor) still loads foreign question', async () => {
    const doc = await questions.findById(legacyForeignQuestion._id.toString());
    assert.equal(doc, legacyForeignQuestion);
  });

  // -------------------------------------------------------- recurring tasks
  const owner = { _id: OID(USER_ID), username: 'narrow', role: 'user', active: true,
    projectScopeMode: 'allowlist', allowedProjectIds: [OID(OWN)], customerScopeMode: 'allowlist', allowedCustomerIds: [] };
  const inactiveOwner = { ...owner, _id: OID(OTHER_USER_ID), active: false };
  const foreignTask = { _id: oid(), projectId: OID(FOREIGN), action: 'todo', title: 't', tags: [] };
  const systemTask = { _id: oid(), action: 'todo', title: 'sys', tags: [] };
  const othersChatTask = { _id: oid(), projectId: OID(OWN), action: 'chat', chat: { prompt: 'p' },
    createdByUserId: OID(OTHER_USER_ID), title: 'c', tags: [], chatSessionIds: [] };
  const ownTodoTask = { _id: oid(), projectId: OID(OWN), action: 'todo', createdByUserId: OID(USER_ID),
    title: 'own', tags: [], frequency: 'daily', hour: 9, nextRun: new Date(Date.now() - 60_000), active: true, maxCatchUp: 1 };
  const orphanTask = { ...ownTodoTask, _id: oid(), createdByUserId: OID(OTHER_USER_ID) };
  const taskModel = fakeModel([foreignTask, systemTask, othersChatTask, ownTodoTask, orphanTask]);
  const userModel = { findById: (id) => q([owner, inactiveOwner].find((u) => u._id.toString() === String(id)) || null) };
  const todoActors = [];
  const recurring = new RecurringTasksService(taskModel, userModel, {
    create: async () => { todoActors.push(RequestContext.getUser()); return { _id: oid() }; },
  }, { create: async () => {} }, { findById: async () => ({}) }, {}, {}, emitter);

  await check('recurring: foreign task get/update/delete/trigger -> 403, nothing written', async () => {
    const id = foreignTask._id.toString();
    await asNarrowed(() => expect403(() => recurring.findById(id)));
    await asNarrowed(() => expect403(() => recurring.update(id, { title: 'x' })));
    await asNarrowed(() => expect403(() => recurring.remove(id)));
    await asNarrowed(() => expect403(() => recurring.trigger(id)));
    assert.equal(taskModel.calls.deletes, 0);
    assert.equal(taskModel.calls.updates, 0);
  });
  await check('recurring: create in foreign project / system task as non-admin -> 403', async () => {
    await asNarrowed(() => expect403(() => recurring.create({ projectId: FOREIGN, title: 't', frequency: 'daily' })));
    await asNarrowed(() => expect403(() => recurring.create({ title: 't', frequency: 'daily' })));
    await asNarrowed(() => expect403(() => recurring.update(systemTask._id.toString(), { title: 'x' })));
    assert.equal(taskModel.calls.creates.length, 0);
  });
  await check('recurring: createdByUserId is not settable — owner is the actor', async () => {
    const dto = plainToInstance(CreateRecurringTaskDto, { projectId: OWN, title: 't', frequency: 'daily', createdByUserId: OTHER_USER_ID });
    const errs = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    assert.ok(errs.some((e) => e.property === 'createdByUserId'), 'DTO must reject createdByUserId');
    await asNarrowed(() => recurring.create({ projectId: OWN, title: 't', frequency: 'daily', createdByUserId: OTHER_USER_ID }));
    assert.equal(taskModel.calls.creates.at(-1).createdByUserId.toString(), USER_ID);
  });
  await check('recurring: chat task of another user cannot be updated/triggered', async () => {
    const id = othersChatTask._id.toString();
    await asNarrowed(() => expect403(() => recurring.update(id, { chat: { prompt: 'exfiltrate' } })));
    await asNarrowed(() => expect403(() => recurring.trigger(id)));
  });
  await check('recurring: scheduler runs todo action as owner, skips inactive owner', async () => {
    taskModel.find = () => q([ownTodoTask, orphanTask]);
    await recurring.processDueTasks();
    assert.equal(todoActors.length, 1, 'only the task with an active owner may run');
    assert.equal(todoActors[0].userId, USER_ID);
    assert.equal(todoActors[0].projectScopeMode, 'allowlist');
    assert.equal(taskModel.calls.lastUpdate.lastRunStatus, 'failed');
    assert.match(taskModel.calls.lastUpdate.lastRunError, /inactive/);
  });

  // ------------------------------------------------------------------- logs
  const logModel = fakeModel();
  const logs = new LogsService(logModel);
  await check('logs: create / batch / read / stats for a foreign project -> 403', async () => {
    await asNarrowed(() => expect403(() => logs.create({ projectId: FOREIGN, message: 'm' })));
    await asNarrowed(() => expect403(() => logs.createBatch([{ projectId: OWN, message: 'a' }, { projectId: FOREIGN, message: 'b' }])));
    assert.equal(logModel.calls.creates.length, 0, 'batch must be all-or-nothing');
    await asNarrowed(() => expect403(() => logs.findByProject(FOREIGN)));
    await asNarrowed(() => expect403(() => logs.stats(FOREIGN)));
    await asNarrowed(() => logs.findByProject(OWN));
    await logs.create({ projectId: FOREIGN, message: 'internal' });
  });
  await check('logs: batch body is validated per entry', async () => {
    const bad = plainToInstance(CreateLogBatchDto, { logs: [{ projectId: 'not-an-id' }] });
    const errs = await validate(bad);
    assert.ok(errs.length > 0, 'invalid entries must fail validation');
    const good = plainToInstance(CreateLogBatchDto, { logs: [{ projectId: OWN, message: 'm' }] });
    assert.equal((await validate(good)).length, 0);
  });

  // ------------------------------------------------------- note promotion
  const createdIn = [];
  const sink = { create: async (d) => { createdIn.push(d); return { _id: oid() }; } };
  const promotion = new NotesPromotionService(
    { findOne: async () => ({ content: 'c', archived: false }), markPromoted: async () => ({ promotedTo: {} }) },
    {}, {}, {}, sink, sink, sink, sink, sink,
  );
  await check('notes promotion: foreign project / customer / global knowledge -> 403 before any create', async () => {
    const note = oid().toString();
    await asNarrowed(() => expect403(() => promotion.commit(USER_ID, note, { entityType: 'todo', projectId: FOREIGN, title: 't' })));
    await asNarrowed(() => expect403(() => promotion.commit(USER_ID, note, { entityType: 'manual', customerId: FOREIGN_CUSTOMER, title: 't' })));
    await asNarrowed(() => expect403(() => promotion.commit(USER_ID, note, { entityType: 'knowledge', title: 't' })));
    assert.equal(createdIn.length, 0);
    await asNarrowed(() => promotion.commit(USER_ID, note, { entityType: 'todo', projectId: OWN, title: 't' }));
    assert.equal(createdIn.length, 1);
  });

  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
})();
