#!/usr/bin/env node
/*
 * Regression check for `ResearchTopicService.buildScope`'s mode-dependent
 * `includeGlobal` default (final-review fix F1, autonomous research-agent).
 *
 * Before this fix, `includeGlobal` defaulted to `true` unconditionally —
 * including for `mode: 'selected'`, whose branch in
 * `RagService.searchScopes` runs one FULLY-UNSCOPED search across every
 * project the owner can see. A `selected` topic with a deliberately narrow,
 * operator-curated project/customer list would therefore silently sweep
 * every other project too. The fix: default `includeGlobal` to
 * `mode === 'all'` — `true` only for `mode: 'all'` (already an unbounded
 * sweep, so the default adds nothing extra), `false` for `mode: 'selected'`.
 * An explicit caller-supplied `includeGlobal` always overrides the default.
 *
 * `buildScope` is a private, side-effect-free method on `ResearchTopicService`
 * (no injected dependency access — `this.validateScope(scope)` is likewise
 * pure), so it's callable directly off the compiled prototype via
 * `Object.create` without going through Nest DI/constructing a real
 * Mongoose-backed instance. Loads compiled output from dist/. Run via
 * `npm run check:research-topic-scope-default` from backend/ after a build.
 */
const assert = require('node:assert/strict');
const { ResearchTopicService } = require('../dist/research-agent/research-topic.service');

const svc = Object.create(ResearchTopicService.prototype);
const PROJECT_ID = '507f1f77bcf86cd799439011';

// mode: 'all', includeGlobal omitted → defaults true.
assert.equal(svc.buildScope({ mode: 'all' }).includeGlobal, true, "mode 'all' must default includeGlobal=true");

// scope omitted entirely → mode defaults to 'all' → includeGlobal true.
assert.equal(svc.buildScope(undefined).includeGlobal, true, 'omitted scope must default to mode=all, includeGlobal=true');

// mode: 'selected' with an explicit project id, includeGlobal omitted →
// defaults false (the F1 fix itself).
assert.equal(
  svc.buildScope({ mode: 'selected', projectIds: [PROJECT_ID] }).includeGlobal,
  false,
  "mode 'selected' must default includeGlobal=false",
);

// Explicit caller value always wins over the mode-dependent default, both
// directions.
assert.equal(
  svc.buildScope({ mode: 'selected', includeGlobal: true }).includeGlobal,
  true,
  'explicit includeGlobal=true must override the selected-mode default',
);
assert.equal(
  svc.buildScope({ mode: 'all', includeGlobal: false }).includeGlobal,
  false,
  'explicit includeGlobal=false must override the all-mode default',
);

// A 'selected' scope with no ids AND no explicit includeGlobal now correctly
// trips the existing "requires at least one projectId/customerId, or
// includeGlobal=true" guard (previously unreachable, since includeGlobal
// used to silently default true regardless of mode).
assert.throws(
  () => svc.buildScope({ mode: 'selected' }),
  /requires at least one projectId\/customerId, or includeGlobal=true/,
  "mode 'selected' with no ids and no explicit includeGlobal must be rejected, not silently widened",
);

console.log('research-topic-scope-default-check OK');
