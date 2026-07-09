#!/usr/bin/env node
/*
 * Regression check for the ResearchTopic Mongoose schema (Task 5,
 * autonomous research-agent, Phase 1).
 *
 * Asserts the compiled schema module exports `ResearchTopicSchema`, the
 * `ResearchFrequency` enum with the expected string values, and the
 * `DEFAULT_GUARDRAILS` constant with the exact guardrail defaults agreed in
 * the design spec.
 *
 * Loads compiled output from dist/. Run via
 * `npm run check:research-topic-schema` from backend/ after a build.
 */
const assert = require('node:assert');
const m = require('../dist/research-agent/schemas/research-topic.schema');
assert.ok(m.ResearchTopicSchema);
assert.strictEqual(m.ResearchFrequency.WEEKLY, 'weekly');
assert.deepStrictEqual(m.DEFAULT_GUARDRAILS, { maxIterations: 12, maxWebSearches: 6, maxWebFetches: 8, timeoutMs: 300000 });
console.log('research-topic-schema-check OK');
