#!/usr/bin/env node
/*
 * Pure-logic regression check for notification click-through URLs (T-355).
 *
 * Bug: clicking a "Quest aktualisiert" notification did not open the todo
 * detail view. Root cause: compactUpdateResult/compactCreateResult emitted
 * `_id` as a Mongoose ObjectId (not a string) and dropped projectId/
 * customerId entirely, so deriveNotificationUrl's `typeof _id === 'string'`
 * guard failed and it returned undefined → notification stored without a
 * url → NotificationBell skipped navigation.
 *
 * Loads compiled helpers from dist/. Run via
 * `npm run check:notification-url` from backend/ after a build.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');

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

const mcp = loadCompiled('mcp-tools.js');
const { compactUpdateResult, compactCreateResult, deriveNotificationUrl } = mcp;

let failures = 0;
let total = 0;
function check(label, fn) {
  total += 1;
  try {
    fn();
    console.log(`✓ ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err.message || err}`);
  }
}

// Mongoose-like doc: toJSON() keeps _id/projectId as ObjectId (no schema
// transform on Todo), exactly as in production.
function fakeDoc(fields) {
  return { toJSON: () => ({ ...fields }) };
}

const todoId = new Types.ObjectId();
const projId = new Types.ObjectId();
const custId = new Types.ObjectId();

check('compactUpdateResult stringifies _id and carries projectId', () => {
  const r = compactUpdateResult(fakeDoc({ _id: todoId, projectId: projId, updatedAt: 'x' }));
  assert.equal(typeof r._id, 'string');
  assert.equal(r._id, todoId.toString());
  assert.equal(r.projectId, projId.toString());
});

check('todo_update (compact result, project-scoped) → todo detail url', () => {
  const result = compactUpdateResult(fakeDoc({ _id: todoId, projectId: projId, updatedAt: 'x' }));
  const url = deriveNotificationUrl('todo_update', { id: todoId.toString() }, result);
  assert.equal(url, `/projects/${projId.toString()}/todos/${todoId.toString()}`);
});

check('todo_create (compact result, project-scoped) → todo detail url', () => {
  const result = compactCreateResult(fakeDoc({ _id: todoId, projectId: projId, createdAt: 'x' }));
  const url = deriveNotificationUrl('todo_create', {}, result);
  assert.equal(url, `/projects/${projId.toString()}/todos/${todoId.toString()}`);
});

check('todo_comment (RAW doc, ObjectId _id) → todo detail url', () => {
  // todo_comment returns todosService.addComment() verbatim (not compacted),
  // so _id/projectId are still ObjectId instances here.
  const raw = { _id: todoId, projectId: projId };
  const url = deriveNotificationUrl('todo_comment', { id: todoId.toString() }, raw);
  assert.equal(url, `/projects/${projId.toString()}/todos/${todoId.toString()}`);
});

check('todo_update (customer-scoped quest) → customer todo detail url', () => {
  const result = compactUpdateResult(fakeDoc({ _id: todoId, customerId: custId, updatedAt: 'x' }));
  const url = deriveNotificationUrl('todo_update', { id: todoId.toString() }, result);
  assert.equal(url, `/customers/${custId.toString()}/todos/${todoId.toString()}`);
});

check('milestone_update (compact result) → milestone detail url', () => {
  const result = compactUpdateResult(fakeDoc({ _id: todoId, projectId: projId, updatedAt: 'x' }));
  const url = deriveNotificationUrl('milestone_update', {}, result);
  assert.equal(url, `/projects/${projId.toString()}/milestones/${todoId.toString()}`);
});

check('project_update (compact result) → project url (regression)', () => {
  const result = compactUpdateResult(fakeDoc({ _id: projId, updatedAt: 'x' }));
  const url = deriveNotificationUrl('project_update', {}, result);
  assert.equal(url, `/projects/${projId.toString()}`);
});

check('knowledge_save still derives project tab url (regression)', () => {
  const result = compactCreateResult(fakeDoc({ _id: todoId, projectId: projId, createdAt: 'x' }));
  const url = deriveNotificationUrl('knowledge_save', {}, result);
  assert.equal(url, `/projects/${projId.toString()}?tab=knowledge`);
});

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
