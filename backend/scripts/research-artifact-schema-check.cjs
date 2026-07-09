#!/usr/bin/env node
/*
 * Regression check for the ResearchArtifact + ResearchArtifactVersion
 * Mongoose schemas (Task 6, autonomous research-agent, Phase 1).
 *
 * Asserts the compiled ResearchArtifactSchema exposes the unique compound
 * index on {topicId, slug} (the identity key artifacts are upserted against)
 * and that the ResearchArtifactVersionSchema exists.
 *
 * Loads compiled output from dist/. Run via
 * `npm run check:research-artifact-schema` from backend/ after a build.
 */
const assert = require('node:assert');
const { ResearchArtifactSchema } = require('../dist/research-agent/schemas/research-artifact.schema');
const { ResearchArtifactVersionSchema } = require('../dist/research-agent/schemas/research-artifact-version.schema');
const hasUnique = ResearchArtifactSchema.indexes().some(([spec, opts]) =>
  spec.topicId === 1 && spec.slug === 1 && opts && opts.unique);
assert.ok(hasUnique, 'unique {topicId,slug} index missing');
assert.ok(ResearchArtifactVersionSchema);
console.log('research-artifact-schema-check OK');
