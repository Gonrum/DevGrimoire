#!/usr/bin/env node
/*
 * Regression check for the pure `RunEventBus` helper (Task 10, autonomous
 * research-agent, Phase 2).
 *
 * `RunEventBus` fans out SSE events for a single research-agent run
 * (`ResearchRunService`) to any number of connected HTTP clients, keyed by
 * runId. It must:
 *  - deliver `publish(runId, e)` events only to subscribers of that SAME
 *    runId (a different runId's subscribers must never see it);
 *  - stop delivering events to a subscriber after its `unsubscribe()` fn
 *    (the callback returned by `subscribe`) has been called;
 *  - deliver a single `publish` call to ALL subscribers currently
 *    registered for that runId, not just the first one.
 *
 * Loads compiled output from dist/. Run via
 * `npm run check:research-run-bus` from backend/ after a build.
 */
const assert = require('node:assert');
const { RunEventBus } = require('../dist/research-agent/research-run.service');

// Basic subscribe/publish/unsubscribe + cross-runId isolation.
{
  const bus = new RunEventBus();
  const got = [];
  const off = bus.subscribe('r1', (e) => got.push(e.type));
  bus.publish('r1', { type: 'step' });
  bus.publish('r2', { type: 'step' }); // andere runId → ignoriert
  off();
  bus.publish('r1', { type: 'done' }); // nach unsubscribe → ignoriert
  assert.deepStrictEqual(got, ['step']);
}

// Multiple subscribers on the same runId all receive the same event.
{
  const bus = new RunEventBus();
  const a = [];
  const b = [];
  bus.subscribe('r1', (e) => a.push(e));
  bus.subscribe('r1', (e) => b.push(e));
  bus.publish('r1', { type: 'artifact', slug: 'x' });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(b.length, 1);
  assert.deepStrictEqual(a[0], { type: 'artifact', slug: 'x' });
  assert.deepStrictEqual(b[0], { type: 'artifact', slug: 'x' });
}

// Unsubscribing one of several subscribers leaves the others intact.
{
  const bus = new RunEventBus();
  const a = [];
  const b = [];
  const offA = bus.subscribe('r1', (e) => a.push(e.type));
  bus.subscribe('r1', (e) => b.push(e.type));
  offA();
  bus.publish('r1', { type: 'step' });
  assert.deepStrictEqual(a, []);
  assert.deepStrictEqual(b, ['step']);
}

// publish() on a runId with no subscribers is a silent no-op.
{
  const bus = new RunEventBus();
  assert.doesNotThrow(() => bus.publish('unknown', { type: 'done' }));
}

console.log('research-run-bus-check OK');
