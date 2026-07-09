#!/usr/bin/env node
/*
 * Regression check for Task 15's due-topic scheduling logic (autonomous
 * research agent, Phase 5): `nextStatusUpdate`, the pure schedule-status-patch
 * helper extracted out of `ResearchTopicService.markRun`.
 *
 * `nextStatusUpdate(topic, ranAt, status)` MUST compute `nextRun` from
 * `ranAt` — the instant the scheduler decided to fire, BEFORE the actual
 * research run executes — not from `Date.now()` at completion time. This is
 * the invariant that keeps a slow/crashing run from being re-fired on the
 * very next cron tick: `ResearchScheduler.handleCron` persists this patch via
 * `ResearchTopicService.markRun` up front, before `ResearchAgentService.run`
 * is even called.
 *
 * Deterministic `ranAt`/`now` throughout (no `Date.now()`), UTC only. Loads
 * compiled output from dist/. Run via `npm run check:research-due` from
 * backend/ after a build.
 */
const assert = require('node:assert');
const { nextStatusUpdate, computeNextRun } = require('../dist/research-agent/research-schedule.util');

// --- nextStatusUpdate: core contract -----------------------------------
const ranAt = new Date('2026-07-09T06:00:00Z'); // Thursday
const schedule = { frequency: 'daily', hour: 6, active: true };
const topic = { schedule };

const patch = nextStatusUpdate(topic, ranAt, 'running');

assert.strictEqual(patch.lastRun.getTime(), ranAt.getTime(), 'lastRun must equal ranAt exactly');
assert.strictEqual(patch.lastRunStatus, 'running');
assert.ok(patch.nextRun > ranAt, 'nextRun must lie strictly in the future relative to ranAt');
assert.strictEqual(
  patch.nextRun.getTime(),
  computeNextRun(ranAt, schedule).getTime(),
  'nextRun must equal computeNextRun(ranAt, schedule) exactly — no drift from a separately-computed "now"',
);

// --- nextStatusUpdate: status is passed through unchanged, whatever it is --
const errorPatch = nextStatusUpdate(topic, ranAt, 'error');
assert.strictEqual(errorPatch.lastRunStatus, 'error');
// nextRun must be identical regardless of status — advancing the schedule is
// independent of whether the run that just fired succeeded or failed.
assert.strictEqual(errorPatch.nextRun.getTime(), patch.nextRun.getTime());

// --- nextStatusUpdate: idempotent across repeated calls with the SAME ranAt
// (mirrors ResearchScheduler calling markRun twice per topic per tick: once
// "pre" with a provisional status, once "post" with the final status — both
// derived from the SAME tick's `ranAt`, so nextRun must not drift between
// the two calls even though real time has passed in between).
const secondPatch = nextStatusUpdate(topic, ranAt, 'done');
assert.strictEqual(secondPatch.nextRun.getTime(), patch.nextRun.getTime());

// --- nextStatusUpdate: a weekly schedule computes correctly through the util
const weeklySchedule = { frequency: 'weekly', hour: 6, dayOfWeek: 1, active: true }; // Monday
const weeklyPatch = nextStatusUpdate({ schedule: weeklySchedule }, ranAt, 'done');
assert.strictEqual(weeklyPatch.nextRun.getUTCDay(), 1);
assert.ok(weeklyPatch.nextRun > ranAt);

console.log('research-due-check OK');
