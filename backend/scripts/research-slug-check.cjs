#!/usr/bin/env node
/*
 * Regression check for the pure `normalizeSlug` helper (Task 9,
 * autonomous research-agent, Phase 2).
 *
 * `normalizeSlug` underpins the `{topicId, slug}` upsert identity of
 * ResearchArtifact (ARTIFACT_UNIQUE) — it must deterministically lowercase,
 * strip to `[a-z0-9]`, collapse separator runs to a single `-`, and trim
 * leading/trailing `-`. An input that normalizes to an empty string (only
 * punctuation/whitespace) must throw rather than silently minting a slug
 * every such artifact in a topic would collide on.
 *
 * Loads compiled output from dist/. Run via
 * `npm run check:research-slug` from backend/ after a build.
 */
const assert = require('node:assert');
const { normalizeSlug } = require('../dist/research-agent/research-artifact.service');

assert.strictEqual(normalizeSlug('LanceDB Features!'), 'lancedb-features');
assert.strictEqual(normalizeSlug('  a__b  '), 'a-b');
assert.throws(() => normalizeSlug('   '));
assert.throws(() => normalizeSlug('!!!'));

console.log('research-slug-check OK');
