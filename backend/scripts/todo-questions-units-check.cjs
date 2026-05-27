#!/usr/bin/env node
/*
 * Pure-logic regression check for the M-46 todo/questions linkage:
 *  - countOpenForTodo invalid-ObjectId guard (no DB roundtrip)
 *  - findOpen filter construction with/without includeAnswered
 *  - convertToKnowledge idempotency guard (rejects already-converted questions)
 *  - handleProjectChange listener: knowledge.deleted clears knowledgeId,
 *    other entities/actions are ignored
 *
 * Mirrors the in-memory stub style used by other check:* scripts (see
 * ssh-service-units-check.cjs). Loads compiled artifacts from dist/.
 * Run with `npm run check:todo-questions-units` after `npm run build`.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { QuestionsService } = loadCompiled('questions/questions.service.js');
const mongoose = require(path.resolve(__dirname, '..', 'node_modules', 'mongoose'));
const { Types } = mongoose;

let failures = 0;
let total = 0;
function check(label, fn) {
  total += 1;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`✓ ${label}`))
    .catch((err) => {
      failures += 1;
      console.error(`✗ ${label}\n    ${err && err.stack ? err.stack : err}`);
    });
}

function matchesObjectIdField(docValue, filterValue) {
  if (filterValue && typeof filterValue === 'object' && '$in' in filterValue) {
    const ids = filterValue.$in.map(String);
    return ids.includes(String(docValue));
  }
  return String(docValue) === String(filterValue);
}

function matchesStatusFilter(docStatus, filterStatus) {
  if (!filterStatus) return true;
  if (typeof filterStatus === 'string') return docStatus === filterStatus;
  if (filterStatus && typeof filterStatus === 'object' && '$in' in filterStatus) {
    return filterStatus.$in.includes(docStatus);
  }
  return true;
}

function applyFilter(docs, filter) {
  return docs.filter((doc) => {
    for (const [k, v] of Object.entries(filter || {})) {
      if (k === '$or' && Array.isArray(v)) {
        const matched = v.some((sub) => applyFilter([doc], sub).length === 1);
        if (!matched) return false;
      } else if (k === 'status') {
        if (!matchesStatusFilter(doc.status, v)) return false;
      } else if (k === '_id' || k === 'todoId' || k === 'projectId' || k === 'knowledgeId') {
        if (!matchesObjectIdField(doc[k], v)) return false;
      } else if (k === 'expiresAt' && v && typeof v === 'object' && '$lte' in v) {
        if (!doc.expiresAt || new Date(doc.expiresAt) > new Date(v.$lte)) return false;
      } else if (k === 'snoozeUntil' && v && typeof v === 'object' && '$lte' in v) {
        if (!doc.snoozeUntil || new Date(doc.snoozeUntil) > new Date(v.$lte)) return false;
      } else if (v instanceof RegExp) {
        const fieldValue = doc[k];
        if (typeof fieldValue !== 'string') return false;
        if (!v.test(fieldValue)) return false;
      } else if (v === undefined || v === null) {
        if (doc[k] !== v) return false;
      } else {
        if (doc[k] !== v) return false;
      }
    }
    return true;
  });
}

/**
 * Minimal Mongoose model surrogate. Captures the surface QuestionsService uses
 * for the methods exercised here.
 */
/**
 * Returns a hand-shaped Mongoose-document surrogate: mutations on the returned
 * object are flushed back to the in-memory store via save(), so a service call
 * that does `await entry.save()` actually persists in the test world.
 */
function makeLiveDoc(store, source) {
  const live = { ...source };
  live.save = async () => {
    const idx = store.findIndex((d) => String(d._id) === String(live._id));
    if (idx >= 0) {
      store[idx] = { ...live };
      delete store[idx].save;
    }
    return live;
  };
  return live;
}

function makeQuestionModel(initialDocs = []) {
  const docs = initialDocs.map((d) => ({ ...d }));
  const model = {
    _docs: docs,
    _lastUpdateMany: null,

    collection: { indexes: async () => [], dropIndex: async () => {} },
    ensureIndexes: async () => {},

    find(filter) {
      const matched = applyFilter(docs, filter);
      const wrapLiveDocs = (limit) => {
        const slice = (limit ? matched.slice(0, limit) : matched).map((d) => makeLiveDoc(docs, d));
        return slice;
      };
      return {
        sort: () => ({
          limit: () => ({
            lean: () => ({ exec: async () => matched.map((d) => ({ ...d })) }),
            exec: async () => wrapLiveDocs(),
          }),
          skip: () => ({
            limit: () => ({ exec: async () => wrapLiveDocs() }),
          }),
          exec: async () => wrapLiveDocs(),
        }),
        limit: (n) => ({
          exec: async () => wrapLiveDocs(n),
        }),
        lean: () => ({ exec: async () => matched.map((d) => ({ ...d })) }),
        exec: async () => wrapLiveDocs(),
      };
    },

    findById(id) {
      const doc = docs.find((d) => String(d._id) === String(id));
      return { exec: async () => (doc ? makeLiveDoc(docs, doc) : null) };
    },

    countDocuments(filter) {
      return { exec: async () => applyFilter(docs, filter).length };
    },

    exists(filter) {
      const matched = applyFilter(docs, filter);
      return Promise.resolve(matched.length > 0 ? { _id: matched[0]._id } : null);
    },

    updateMany(filter, update) {
      model._lastUpdateMany = { filter, update };
      const matched = applyFilter(docs, filter);
      for (const doc of matched) {
        if (update && update.$unset) {
          for (const key of Object.keys(update.$unset)) {
            const target = docs.find((d) => String(d._id) === String(doc._id));
            if (target) delete target[key];
          }
        }
      }
      return { exec: async () => ({ modifiedCount: matched.length }) };
    },
  };
  return model;
}

function instantiateService(questionModel, overrides = {}) {
  const eventEmitter = { emit: () => {}, on: () => {} };
  const todosService = {
    findById: async () => ({ projectId: new Types.ObjectId() }),
    linkQuestion: async () => {},
    addComment: async () => {},
    create: async (dto) => ({ _id: new Types.ObjectId(), ...dto }),
  };
  const notificationsService = { create: async () => {} };
  const knowledgeService = {
    create: async (dto) => ({ _id: new Types.ObjectId(), ...dto }),
  };
  const authService = {
    findUserById: async () => null,
    resolveQuestionTargets: async () => ({ userIds: [], usernames: {} }),
  };
  const auditLog = {
    records: [],
    record: async (entry) => {
      auditLog.records.push(entry);
    },
  };

  const service = new QuestionsService(
    questionModel,
    overrides.eventEmitter ?? eventEmitter,
    overrides.todosService ?? todosService,
    overrides.notificationsService ?? notificationsService,
    overrides.knowledgeService ?? knowledgeService,
    overrides.authService ?? authService,
    overrides.auditLog ?? auditLog,
  );
  service._auditLog = overrides.auditLog ?? auditLog;
  service._todosService = overrides.todosService ?? todosService;
  service._knowledgeService = overrides.knowledgeService ?? knowledgeService;
  return service;
}

// ------------------------------------------------------------------
// countOpenForTodo: invalid ObjectId short-circuits to {count:0,items:[]}
// ------------------------------------------------------------------
check('countOpenForTodo: invalid ObjectId returns empty without DB call', async () => {
  const model = makeQuestionModel();
  const existsSpy = { called: false };
  model.exists = (filter) => {
    existsSpy.called = true;
    return Promise.resolve(null);
  };
  const svc = instantiateService(model);
  const result = await svc.countOpenForTodo('not-a-valid-objectid');
  assert.deepEqual(result, { count: 0, items: [] });
  assert.equal(existsSpy.called, false, 'exists() must not be called for invalid IDs');
});

check('countOpenForTodo: happy path returns pending+expired items', async () => {
  const todoId = new Types.ObjectId();
  const model = makeQuestionModel([
    { _id: new Types.ObjectId(), todoId, status: 'pending', question: 'q1', createdAt: new Date() },
    { _id: new Types.ObjectId(), todoId, status: 'expired', question: 'q2', createdAt: new Date() },
    { _id: new Types.ObjectId(), todoId, status: 'answered', question: 'q3', createdAt: new Date() },
  ]);
  const svc = instantiateService(model);
  const result = await svc.countOpenForTodo(todoId.toString());
  assert.equal(result.count, 2);
  assert.deepEqual(result.items.map((i) => i.question).sort(), ['q1', 'q2']);
});

// ------------------------------------------------------------------
// findOpen: includeAnswered toggle controls whether status filter is applied
// ------------------------------------------------------------------
check('findOpen: default excludes answered (status pending+expired only)', async () => {
  const projectId = new Types.ObjectId();
  const model = makeQuestionModel([
    { _id: new Types.ObjectId(), projectId, status: 'pending', question: 'p', createdAt: new Date() },
    { _id: new Types.ObjectId(), projectId, status: 'expired', question: 'e', createdAt: new Date() },
    { _id: new Types.ObjectId(), projectId, status: 'answered', question: 'a', createdAt: new Date() },
  ]);
  const svc = instantiateService(model);
  const result = await svc.findOpen({ projectId: projectId.toString() });
  assert.equal(result.total, 2);
});

check('findOpen: includeAnswered=true returns all statuses', async () => {
  const projectId = new Types.ObjectId();
  const model = makeQuestionModel([
    { _id: new Types.ObjectId(), projectId, status: 'pending', question: 'p', createdAt: new Date() },
    { _id: new Types.ObjectId(), projectId, status: 'expired', question: 'e', createdAt: new Date() },
    { _id: new Types.ObjectId(), projectId, status: 'answered', question: 'a', createdAt: new Date() },
  ]);
  const svc = instantiateService(model);
  const result = await svc.findOpen({ projectId: projectId.toString(), includeAnswered: true });
  assert.equal(result.total, 3);
});

// ------------------------------------------------------------------
// convertToKnowledge: idempotency guard rejects double-conversion
// ------------------------------------------------------------------
check('convertToKnowledge: throws when question already has knowledgeId', async () => {
  const questionId = new Types.ObjectId();
  const existingKnowledgeId = new Types.ObjectId();
  const model = makeQuestionModel([
    {
      _id: questionId,
      question: 'q',
      answer: 'a',
      status: 'answered',
      knowledgeId: existingKnowledgeId,
    },
  ]);
  const svc = instantiateService(model);
  await assert.rejects(
    () => svc.convertToKnowledge(questionId.toString(), { topic: 'Topic' }),
    (err) => {
      const response = err && err.response;
      return response && response.code === 'QUESTION_ALREADY_CONVERTED';
    },
    'expected QUESTION_ALREADY_CONVERTED BadRequestException',
  );
});

check('convertToKnowledge: throws when question is not yet answered', async () => {
  const questionId = new Types.ObjectId();
  const model = makeQuestionModel([
    { _id: questionId, question: 'q', status: 'pending' },
  ]);
  const svc = instantiateService(model);
  await assert.rejects(
    () => svc.convertToKnowledge(questionId.toString(), { topic: 'Topic' }),
    /must be answered/,
  );
});

// ------------------------------------------------------------------
// handleProjectChange: knowledge.deleted clears knowledgeId on questions
// ------------------------------------------------------------------
check('handleProjectChange: knowledge.deleted clears knowledgeId on matching questions', async () => {
  const knowledgeId = new Types.ObjectId();
  const model = makeQuestionModel([
    { _id: new Types.ObjectId(), question: 'q1', knowledgeId },
    { _id: new Types.ObjectId(), question: 'q2', knowledgeId: new Types.ObjectId() },
  ]);
  const svc = instantiateService(model);
  await svc.handleProjectChange({
    projectId: null,
    entity: 'knowledge',
    action: 'deleted',
    entityId: knowledgeId.toString(),
  });
  assert.ok(model._lastUpdateMany, 'expected updateMany to be called');
  assert.equal(
    String(model._lastUpdateMany.filter.knowledgeId),
    String(knowledgeId),
    'filter must target the deleted knowledgeId',
  );
  assert.deepEqual(model._lastUpdateMany.update, { $unset: { knowledgeId: '' } });
});

check('handleProjectChange: ignores non-knowledge entities', async () => {
  const model = makeQuestionModel([]);
  const svc = instantiateService(model);
  await svc.handleProjectChange({
    projectId: null,
    entity: 'todo',
    action: 'deleted',
    entityId: new Types.ObjectId().toString(),
  });
  assert.equal(model._lastUpdateMany, null, 'updateMany must not be called for non-knowledge events');
});

check('handleProjectChange: ignores non-deleted actions', async () => {
  const model = makeQuestionModel([]);
  const svc = instantiateService(model);
  await svc.handleProjectChange({
    projectId: null,
    entity: 'knowledge',
    action: 'updated',
    entityId: new Types.ObjectId().toString(),
  });
  assert.equal(model._lastUpdateMany, null, 'updateMany must not be called for updated/created events');
});

check('handleProjectChange: ignores invalid entityId', async () => {
  const model = makeQuestionModel([]);
  const svc = instantiateService(model);
  await svc.handleProjectChange({
    projectId: null,
    entity: 'knowledge',
    action: 'deleted',
    entityId: 'not-a-valid-objectid',
  });
  assert.equal(model._lastUpdateMany, null, 'updateMany must not be called for invalid IDs');
});

// ------------------------------------------------------------------
// T-393 multi-target / answer / escalation
// ------------------------------------------------------------------

check('answer: multi-target appends to responses without blocking', async () => {
  const questionId = new Types.ObjectId();
  const userA = new Types.ObjectId();
  const userB = new Types.ObjectId();
  const model = makeQuestionModel([
    {
      _id: questionId,
      question: 'q',
      options: [],
      direction: 'agent_to_user',
      status: 'pending',
      broadcast: true,
      targetRole: undefined,
      resolvedTargetUserIds: [userA, userB],
      responses: [],
    },
  ]);
  const svc = instantiateService(model, {
    authService: {
      findUserById: async (id) => ({ username: `user_${String(id).slice(0, 4)}` }),
      resolveQuestionTargets: async () => ({ userIds: [], usernames: {} }),
    },
  });
  const after1 = await svc.answer(questionId.toString(), 'first', { userId: userA.toString() });
  assert.equal(after1.status, 'answered', 'first answer flips status to answered');
  assert.equal(after1.answer, 'first', 'legacy answer field stamps winning reply');
  assert.equal(after1.responses.length, 1);

  const after2 = await svc.answer(questionId.toString(), 'second', { userId: userB.toString() });
  assert.equal(after2.status, 'answered', 'status stays answered');
  assert.equal(after2.answer, 'first', 'legacy answer field stays at first response');
  assert.equal(after2.responses.length, 2, 'second response appended');
  assert.equal(after2.responses[1].answer, 'second');
});

check('answer: single-target rejects double-answer', async () => {
  const questionId = new Types.ObjectId();
  const userA = new Types.ObjectId();
  const model = makeQuestionModel([
    {
      _id: questionId,
      question: 'q',
      options: [],
      direction: 'agent_to_user',
      status: 'pending',
      broadcast: false,
      targetRole: undefined,
      resolvedTargetUserIds: [userA],
      responses: [],
    },
  ]);
  const svc = instantiateService(model);
  await svc.answer(questionId.toString(), 'first', { userId: userA.toString() });
  await assert.rejects(
    () => svc.answer(questionId.toString(), 'second', { userId: userA.toString() }),
    /already answered/,
    'single-target question must reject the second answer',
  );
});

check('answer: permission filter blocks non-target users', async () => {
  const questionId = new Types.ObjectId();
  const userA = new Types.ObjectId();
  const intruder = new Types.ObjectId();
  const model = makeQuestionModel([
    {
      _id: questionId,
      question: 'q',
      options: [],
      direction: 'agent_to_user',
      status: 'pending',
      broadcast: false,
      resolvedTargetUserIds: [userA],
      responses: [],
    },
  ]);
  const svc = instantiateService(model);
  await assert.rejects(
    () => svc.answer(questionId.toString(), 'nope', { userId: intruder.toString() }),
    /not addressed/,
    'a user not in resolvedTargetUserIds must not be allowed to answer',
  );
});

check('escalateDueQuestions: no due questions → noop', async () => {
  const model = makeQuestionModel([]);
  const svc = instantiateService(model);
  const summary = await svc.escalateDueQuestions();
  assert.deepEqual(summary, { checked: 0, escalated: 0, expired: 0 });
});

check('escalateDueQuestions: due question without chain → expired', async () => {
  const questionId = new Types.ObjectId();
  const model = makeQuestionModel([
    {
      _id: questionId,
      question: 'q',
      direction: 'agent_to_user',
      status: 'pending',
      expiresAt: new Date(Date.now() - 60_000),
      escalationChain: [],
      escalationStep: 0,
      escalationHistory: [],
      resolvedTargetUserIds: [],
    },
  ]);
  const svc = instantiateService(model);
  const summary = await svc.escalateDueQuestions();
  assert.equal(summary.checked, 1);
  assert.equal(summary.expired, 1);
  assert.equal(summary.escalated, 0);
  const stored = model._docs.find((d) => String(d._id) === String(questionId));
  assert.equal(stored.status, 'expired');
});

check('escalateDueQuestions: due question with chain → walks one step', async () => {
  const questionId = new Types.ObjectId();
  const target = new Types.ObjectId();
  const model = makeQuestionModel([
    {
      _id: questionId,
      question: 'q',
      direction: 'agent_to_user',
      status: 'pending',
      expiresAt: new Date(Date.now() - 60_000),
      escalationChain: [
        { kind: 'role', role: 'admin', afterMs: 60_000 },
        { kind: 'broadcast', afterMs: 120_000 },
      ],
      escalationStep: 0,
      escalationHistory: [],
      resolvedTargetUserIds: [],
    },
  ]);
  const svc = instantiateService(model, {
    authService: {
      findUserById: async () => null,
      resolveQuestionTargets: async () => ({
        userIds: [target.toString()],
        usernames: { [target.toString()]: 'admin' },
      }),
    },
  });
  const summary = await svc.escalateDueQuestions();
  assert.equal(summary.checked, 1);
  assert.equal(summary.escalated, 1);
  assert.equal(summary.expired, 0);
  const stored = model._docs.find((d) => String(d._id) === String(questionId));
  assert.equal(stored.status, 'pending', 'question stays pending after escalation');
  assert.equal(stored.escalationStep, 1, 'escalationStep advanced');
  assert.equal(stored.targetRole, 'admin');
  assert.equal(stored.escalationHistory.length, 1);
  assert.ok(stored.expiresAt > new Date(), 'expiresAt re-armed into the future');
});

// ------------------------------------------------------------------
// T-394 lifecycle (cancel / snooze / supersede / wake) + audit
// ------------------------------------------------------------------

check('cancel: pending → cancelled, audit recorded', async () => {
  const questionId = new Types.ObjectId();
  const model = makeQuestionModel([
    { _id: questionId, question: 'q', status: 'pending', direction: 'agent_to_user' },
  ]);
  const svc = instantiateService(model);
  const after = await svc.cancel(questionId.toString(), 'no longer needed', 'user-abc');
  assert.equal(after.status, 'cancelled');
  assert.equal(after.closeReason, 'no longer needed');
  const audit = svc._auditLog.records.find((r) => r.action === 'question.cancelled');
  assert.ok(audit, 'audit entry question.cancelled emitted');
  assert.equal(audit.entityType, 'question');
  assert.equal(audit.actor.userId, 'user-abc');
});

check('cancel: answered question is rejected', async () => {
  const questionId = new Types.ObjectId();
  const model = makeQuestionModel([
    { _id: questionId, question: 'q', status: 'answered' },
  ]);
  const svc = instantiateService(model);
  await assert.rejects(() => svc.cancel(questionId.toString()), /already-answered/);
});

check('snooze: rejects past dates', async () => {
  const questionId = new Types.ObjectId();
  const model = makeQuestionModel([
    { _id: questionId, question: 'q', status: 'pending' },
  ]);
  const svc = instantiateService(model);
  await assert.rejects(
    () => svc.snooze(questionId.toString(), new Date(Date.now() - 60_000)),
    /future date/,
  );
});

check('snooze + wake roundtrip', async () => {
  const questionId = new Types.ObjectId();
  const model = makeQuestionModel([
    {
      _id: questionId,
      question: 'q',
      status: 'pending',
      direction: 'agent_to_user',
      timeoutMs: 300_000,
    },
  ]);
  const svc = instantiateService(model);
  const future = new Date(Date.now() + 1_000);
  await svc.snooze(questionId.toString(), future);
  // Simulate the snooze elapsing by manually backdating the stored snoozeUntil.
  const stored = model._docs.find((d) => String(d._id) === String(questionId));
  stored.snoozeUntil = new Date(Date.now() - 1_000);
  const summary = await svc.wakeSnoozedQuestions();
  assert.equal(summary.woken, 1);
  const fresh = model._docs.find((d) => String(d._id) === String(questionId));
  assert.equal(fresh.status, 'pending', 'wake flips status back to pending');
  assert.ok(fresh.expiresAt > new Date(), 'expiresAt re-armed into the future');
});

check('supersede: rejects invalid replacement id', async () => {
  const questionId = new Types.ObjectId();
  const model = makeQuestionModel([
    { _id: questionId, question: 'q', status: 'pending' },
  ]);
  const svc = instantiateService(model);
  await assert.rejects(() => svc.supersede(questionId.toString(), 'not-an-objectid'), /Invalid/);
});

// ------------------------------------------------------------------
// T-391 follow-up actions
// ------------------------------------------------------------------

check('createFollowupTodo: persists backlink + audit', async () => {
  const questionId = new Types.ObjectId();
  const projectId = new Types.ObjectId();
  const model = makeQuestionModel([
    {
      _id: questionId,
      question: 'should we cache the results?',
      answer: 'yes — TTL 30s',
      status: 'answered',
      direction: 'agent_to_user',
      projectId,
    },
  ]);
  const svc = instantiateService(model);
  const { todoId, question } = await svc.createFollowupTodo(questionId.toString());
  assert.ok(todoId);
  assert.equal(String(question.followupTodoId), todoId);
  const audit = svc._auditLog.records.find((r) => r.action === 'question.followup_created');
  assert.ok(audit, 'audit entry emitted');
});

check('createFollowupTodo: rejects when already exists', async () => {
  const questionId = new Types.ObjectId();
  const projectId = new Types.ObjectId();
  const model = makeQuestionModel([
    {
      _id: questionId,
      question: 'q',
      answer: 'a',
      status: 'answered',
      direction: 'agent_to_user',
      projectId,
      followupTodoId: new Types.ObjectId(),
    },
  ]);
  const svc = instantiateService(model);
  await assert.rejects(
    () => svc.createFollowupTodo(questionId.toString()),
    (err) => err?.response?.code === 'FOLLOWUP_ALREADY_EXISTS',
  );
});

check('markAsDecision: creates knowledge with decision category', async () => {
  const questionId = new Types.ObjectId();
  const projectId = new Types.ObjectId();
  const captured = [];
  const knowledgeService = {
    create: async (dto) => {
      captured.push(dto);
      return { _id: new Types.ObjectId(), ...dto };
    },
  };
  const model = makeQuestionModel([
    {
      _id: questionId,
      question: 'q',
      answer: 'a',
      status: 'answered',
      direction: 'agent_to_user',
      projectId,
    },
  ]);
  const svc = instantiateService(model, { knowledgeService });
  const { knowledgeId, question } = await svc.markAsDecision(questionId.toString(), {
    decision: 'use cache',
    rationale: 'latency requirement',
    scope: 'Frontend',
  });
  assert.ok(knowledgeId);
  assert.equal(String(question.decisionKnowledgeId), knowledgeId);
  assert.equal(captured[0].category, 'decision');
  assert.equal(captured[0].sourceQuestionId, questionId.toString());
});

check('markAsDecision: rejects when already decided', async () => {
  const questionId = new Types.ObjectId();
  const projectId = new Types.ObjectId();
  const model = makeQuestionModel([
    {
      _id: questionId,
      question: 'q',
      answer: 'a',
      status: 'answered',
      direction: 'agent_to_user',
      projectId,
      decisionKnowledgeId: new Types.ObjectId(),
    },
  ]);
  const svc = instantiateService(model);
  await assert.rejects(
    () => svc.markAsDecision(questionId.toString(), { decision: 'x' }),
    (err) => err?.response?.code === 'DECISION_ALREADY_EXISTS',
  );
});

// ------------------------------------------------------------------
// T-389 findAll filter
// ------------------------------------------------------------------

check('findAll: status + q text filter narrows results', async () => {
  const projectId = new Types.ObjectId();
  const model = makeQuestionModel([
    { _id: new Types.ObjectId(), projectId, status: 'pending', question: 'do we cache?', context: '', answer: undefined, createdAt: new Date() },
    { _id: new Types.ObjectId(), projectId, status: 'answered', question: 'database engine?', context: 'pgsql vs mongo', answer: 'mongo', createdAt: new Date() },
    { _id: new Types.ObjectId(), projectId, status: 'cancelled', question: 'unrelated', context: '', answer: undefined, createdAt: new Date() },
  ]);
  const svc = instantiateService(model);
  const allOpen = await svc.findAll({ statuses: ['pending', 'answered'] });
  assert.equal(allOpen.total, 2);
  const cached = await svc.findAll({ q: 'cache' });
  assert.equal(cached.total, 1);
  const mongoText = await svc.findAll({ q: 'mongo' });
  assert.equal(mongoText.total, 1, 'matches inside answer field');
});

// ------------------------------------------------------------------
(async () => {
  // Allow the parallel `check` invocations above to settle.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  if (failures > 0) {
    console.error(`\n${failures}/${total} checks failed`);
    process.exit(1);
  }
  console.log(`\nAll ${total} checks passed`);
})();
