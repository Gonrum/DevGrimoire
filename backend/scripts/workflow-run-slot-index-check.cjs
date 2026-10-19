#!/usr/bin/env node
/**
 * Der Slot-Unique-Index gilt nur für Zeitplan-Läufe.
 *
 * Vorher war er `sparse` — bei einem zusammengesetzten Index wirkt das nur,
 * wenn *alle* Felder fehlen, `definitionId` ist aber immer gesetzt. Jeder
 * manuelle Lauf zählte damit als Slot `null`: ab dem zweiten Start E11000,
 * im UI ein 500 "Internal server error".
 *
 * Läuft gegen `dist/`, ohne Nest/Mongo. Nach `npm run build` ausführen.
 */
const assert = require('node:assert/strict');
const { WorkflowRunSchema, SCHEDULE_SLOT_INDEX } = require('../dist/workflows/schemas/workflow-run.schema');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

const slotIndex = () => WorkflowRunSchema.indexes().find(([, opts]) => opts && opts.name === SCHEDULE_SLOT_INDEX);

check('Slot-Index existiert, unique, auf definitionId + scheduleSlotAt', () => {
  const idx = slotIndex();
  assert.ok(idx, `Index ${SCHEDULE_SLOT_INDEX} fehlt`);
  assert.deepEqual(idx[0], { definitionId: 1, 'triggeredBy.scheduleSlotAt': 1 });
  assert.equal(idx[1].unique, true);
});

check('Slot-Index ist partiell (nur Läufe mit Slot-Datum), nicht sparse', () => {
  const [, opts] = slotIndex();
  assert.notEqual(opts.sparse, true);
  assert.deepEqual(opts.partialFilterExpression, { 'triggeredBy.scheduleSlotAt': { $type: 'date' } });
});

check('alter Indexname wird nicht mehr verwendet', () => {
  assert.notEqual(SCHEDULE_SLOT_INDEX, 'uniq_run_per_schedule_slot');
});

console.log(`${passed} checks passed`);
