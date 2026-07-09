#!/usr/bin/env node
/*
 * Regression check for the ResearchRun Mongoose schema (Task 7,
 * autonomous research-agent, Phase 1).
 *
 * Asserts the compiled schema module exports `ResearchRunSchema` and the
 * `ResearchRunStatus` enum with the expected string values (in particular
 * RUNNING === 'running', per the design spec).
 *
 * Loads compiled output from dist/. Run via
 * `npm run check:research-run-schema` from backend/ after a build.
 */
const assert = require('node:assert');
const m = require('../dist/research-agent/schemas/research-run.schema');
assert.ok(m.ResearchRunSchema);
assert.strictEqual(m.ResearchRunStatus.RUNNING, 'running');
console.log('research-run-schema-check OK');
