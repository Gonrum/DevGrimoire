#!/usr/bin/env node
/**
 * Kein überlappender Zeitplan-Lauf.
 *
 * Gegen Attrappen (Definitions-Modell, WorkflowsService, AuditLogService):
 *   - offener Lauf: startRun wird nicht aufgerufen, Audit mit slot, nextRunAt/lastRunAt laufen weiter
 *   - kein offener Lauf: startRun wird aufgerufen, kein Audit
 *   - mehrere verpasste Slots: nach dem ersten Start sind die übrigen übersprungen (kein Nachholen)
 *   - WorkflowsService.hasOpenRun fragt nur Läufe ausserhalb TERMINAL_RUN_STATUSES ab
 *
 * Läuft gegen `dist/`, ohne Nest/Mongo. Nach `npm run build` ausführen.
 */
const assert = require('node:assert/strict');
const { WorkflowSchedulerService } = require('../dist/workflows/engine/workflow-scheduler.service');
const { WorkflowsService } = require('../dist/workflows/workflows.service');
const { TERMINAL_RUN_STATUSES } = require('../dist/workflows/engine/run-status');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

const DEF_ID = '64b0000000000000000000de';
const NOW = new Date('2026-01-01T10:00:00.000Z');

function makeDef(lastRunAt) {
  return {
    _id: { toString: () => DEF_ID },
    name: 'wartung',
    trigger: { type: 'schedule', intervalMinutes: 15, maxCatchUp: 5 },
    lastRunAt,
    nextRunAt: undefined,
    saved: 0,
    async save() { this.saved += 1; },
  };
}

function setup(open) {
  const started = [];
  const audits = [];
  const opened = [];
  const workflows = {
    hasOpenRun: async (id) => { opened.push(id); return open; },
    startRun: async (dto) => { started.push(dto); return {}; },
  };
  const audit = { record: async (e) => { audits.push(e); } };
  const scheduler = new WorkflowSchedulerService({}, workflows, audit);
  scheduler.logger.debug = () => {};
  return { scheduler, started, audits, opened };
}

(async () => {
  await check('offener Lauf: Slot übersprungen, Audit, Zeiger laufen weiter', async () => {
    const { scheduler, started, audits } = setup(true);
    const def = makeDef(new Date('2026-01-01T09:40:00.000Z'));
    await scheduler.processDefinition(def, NOW);
    assert.equal(started.length, 0);
    assert.ok(audits.length >= 1);
    for (const a of audits) {
      assert.equal(a.action, 'workflow.schedule.skipped_overlap');
      assert.equal(a.entityType, 'workflow-definition');
      assert.equal(a.entityId, DEF_ID);
      assert.equal(typeof a.meta.slot, 'string');
    }
    assert.ok(def.nextRunAt instanceof Date && def.nextRunAt > NOW);
    assert.equal(def.lastRunAt, NOW);
    assert.equal(def.saved, 1);
  });

  await check('kein offener Lauf: startRun wird aufgerufen, kein Audit', async () => {
    const { scheduler, started, audits } = setup(false);
    const def = makeDef(new Date('2026-01-01T09:40:00.000Z'));
    await scheduler.processDefinition(def, NOW);
    assert.ok(started.length >= 1);
    assert.equal(audits.length, 0);
    assert.ok(def.nextRunAt > NOW);
  });

  await check('mehrere Slots: nach dem ersten Start sind die übrigen übersprungen', async () => {
    const started = [];
    const audits = [];
    let open = false;
    const workflows = {
      hasOpenRun: async () => open,
      startRun: async (dto) => { started.push(dto); open = true; return {}; },
    };
    const scheduler = new WorkflowSchedulerService({}, workflows, { record: async (e) => { audits.push(e); } });
    scheduler.logger.debug = () => {};
    await scheduler.processDefinition(makeDef(new Date('2026-01-01T09:20:00.000Z')), NOW);
    assert.equal(started.length, 1);
    assert.ok(audits.length >= 1);
  });

  await check('hasOpenRun filtert auf Status ausserhalb TERMINAL_RUN_STATUSES', async () => {
    let filter;
    let result = null;
    const runModel = { exists: (f) => { filter = f; return { exec: async () => result }; } };
    const svc = Object.create(WorkflowsService.prototype);
    svc.runModel = runModel;
    const id = { _marker: true };
    assert.equal(await svc.hasOpenRun(id), false);
    assert.equal(filter.definitionId, id);
    assert.deepEqual(filter.status, { $nin: TERMINAL_RUN_STATUSES });
    result = { _id: 1 };
    assert.equal(await svc.hasOpenRun(id), true);
  });

  console.log(`${passed} checks passed`);
})();
