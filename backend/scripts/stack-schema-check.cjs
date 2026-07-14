#!/usr/bin/env node
/*
 * Regression check for the Stack Mongoose schema.
 * Asserts embedded StackEntry with _id + required title/order and String content.
 * Loads compiled output from dist/. Run via `npm run check:stack-schema` after a build.
 */
const assert = require('node:assert');
const m = require('../dist/stacks/schemas/stack.schema');

assert.ok(m.StackSchema, 'StackSchema export missing');
assert.ok(m.StackEntrySchema, 'StackEntrySchema export missing');

const entries = m.StackSchema.path('entries');
assert.ok(entries, 'entries path missing');
assert.strictEqual(entries.instance, 'Array', 'entries must be an Array');

assert.strictEqual(m.StackSchema.path('name').instance, 'String', 'name must be String');
assert.strictEqual(m.StackSchema.path('name').isRequired, true, 'name must be required');

const sub = m.StackEntrySchema;
assert.ok(sub.path('_id'), 'entry must have _id');
assert.strictEqual(sub.path('title').isRequired, true, 'entry.title must be required');
assert.strictEqual(sub.path('content').instance, 'String', 'entry.content must be String');
assert.strictEqual(sub.path('order').instance, 'Number', 'entry.order must be Number');

assert.strictEqual(m.StackSchema.options.timestamps, true, 'timestamps must be enabled');
assert.notStrictEqual(m.StackSchema.path('description').isRequired, true, 'description must be optional');
assert.strictEqual(entries.$isMongooseDocumentArray, true, 'entries must be a subdocument array');

console.log('stack-schema-check OK');
