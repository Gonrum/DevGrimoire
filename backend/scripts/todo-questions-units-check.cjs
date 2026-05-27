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
      if (k === 'status') {
        if (!matchesStatusFilter(doc.status, v)) return false;
      } else if (k === '_id' || k === 'todoId' || k === 'projectId' || k === 'knowledgeId') {
        if (!matchesObjectIdField(doc[k], v)) return false;
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
function makeQuestionModel(initialDocs = []) {
  const docs = initialDocs.map((d) => ({ ...d }));
  const model = {
    _docs: docs,
    _lastUpdateMany: null,

    collection: { indexes: async () => [], dropIndex: async () => {} },
    ensureIndexes: async () => {},

    find(filter) {
      const matched = applyFilter(docs, filter);
      return {
        sort: () => ({
          limit: () => ({
            lean: () => ({ exec: async () => matched.map((d) => ({ ...d })) }),
            exec: async () => matched.map((d) => ({ ...d })),
          }),
          skip: () => ({
            limit: () => ({ exec: async () => matched.map((d) => ({ ...d })) }),
          }),
          exec: async () => matched.map((d) => ({ ...d })),
        }),
        lean: () => ({ exec: async () => matched.map((d) => ({ ...d })) }),
        exec: async () => matched.map((d) => ({ ...d })),
      };
    },

    findById(id) {
      const doc = docs.find((d) => String(d._id) === String(id));
      return { exec: async () => (doc ? { ...doc, save: async () => doc } : null) };
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
  };
  const notificationsService = { create: async () => {} };
  const knowledgeService = { create: async () => ({ _id: new Types.ObjectId() }) };

  return new QuestionsService(
    questionModel,
    overrides.eventEmitter ?? eventEmitter,
    overrides.todosService ?? todosService,
    overrides.notificationsService ?? notificationsService,
    overrides.knowledgeService ?? knowledgeService,
  );
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
