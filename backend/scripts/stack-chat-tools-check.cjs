#!/usr/bin/env node
/*
 * Regression check for stack tool exposure to the internal chat.
 * Loads compiled output from dist/. Run via `npm run check:stack-chat-tools` after a build.
 */
const assert = require('node:assert');
const m = require('../dist/chat/chat-tools');

assert.ok(m.TOOL_GROUPS.stacks_read, 'stacks_read group missing');
assert.ok(m.TOOL_GROUPS.stacks_write, 'stacks_write group missing');
assert.ok(m.TOOL_GROUPS.stacks_read.includes('stack_list'), 'stacks_read missing stack_list');
assert.ok(m.TOOL_GROUPS.stacks_read.includes('stack_get'), 'stacks_read missing stack_get');
assert.ok(m.TOOL_GROUPS.stacks_read.includes('stack_export_markdown'), 'stacks_read missing stack_export_markdown');
assert.ok(m.TOOL_GROUPS.stacks_write.includes('stack_create'), 'stacks_write missing stack_create');
assert.ok(m.TOOL_GROUPS.stacks_write.includes('stack_entry_add'), 'stacks_write missing stack_entry_add');

assert.ok(m.ALL_TOOL_NAMES.includes('stack_update'), 'ALL_TOOL_NAMES missing stack_update');
// WRITE_TOOL_NAMES / PERMANENTLY_BLOCKED_TOOLS are Set<string> in chat-tools.ts, not arrays — use .has().
assert.ok(m.WRITE_TOOL_NAMES.has('stack_entry_update'), 'WRITE_TOOL_NAMES missing stack_entry_update');
assert.ok(m.PERMANENTLY_BLOCKED_TOOLS.has('stack_delete'), 'stack_delete must be permanently blocked');
assert.ok(!m.ALL_TOOL_NAMES.includes('stack_delete'), 'stack_delete must NOT be in any chat group');

const defs = m.TOOL_DEFINITIONS;
const defNames = Array.isArray(defs) ? defs.map((d) => d.name) : Object.keys(defs);
for (const n of ['stack_list', 'stack_get', 'stack_create', 'stack_entry_add', 'stack_export_markdown']) {
  assert.ok(defNames.includes(n), `TOOL_DEFINITIONS missing ${n}`);
}

console.log('stack-chat-tools-check OK');
