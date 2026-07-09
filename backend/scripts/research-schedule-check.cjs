#!/usr/bin/env node
/*
 * Regression check for the pure `computeNextRun` schedule-math util (Task 8,
 * autonomous research-agent, Phase 2).
 *
 * `computeNextRun` is deliberately a standalone pure function (no `this`, no
 * argument-less `new Date()`) ported from
 * `recurring-tasks.service.ts#computeNextRunFromDate` — decoupling the
 * research-agent module from recurring-tasks (pre-confirmed design decision,
 * not a DRY defect). Computation happens in UTC so this check stays
 * timezone-robust regardless of the machine it runs on.
 *
 * Loads compiled output from dist/. Run via
 * `npm run check:research-schedule` from backend/ after a build.
 */
const assert = require('node:assert');
const { computeNextRun } = require('../dist/research-agent/research-schedule.util');

const from = new Date('2026-07-09T05:00:00Z'); // Thursday

const daily = computeNextRun(from, { frequency: 'daily', hour: 6 });
assert.strictEqual(daily.getUTCHours(), 6);
assert.ok(daily > from);

const weekly = computeNextRun(from, { frequency: 'weekly', hour: 6, dayOfWeek: 1 }); // Monday
assert.strictEqual(weekly.getUTCDay(), 1);
assert.strictEqual(weekly.getUTCHours(), 6);
assert.ok(weekly > from);

const monthly = computeNextRun(from, { frequency: 'monthly', hour: 6, dayOfMonth: 15 });
assert.strictEqual(monthly.getUTCDate(), 15);
assert.strictEqual(monthly.getUTCHours(), 6);
assert.ok(monthly > from);

console.log('research-schedule-check OK');
