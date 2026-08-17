#!/usr/bin/env node
/**
 * Migrationsplanung Soul/instructions/agent_instructions → Harness (T-442).
 *
 * Prüft die reine Planungsfunktion — vor allem die Eigenschaft, an der die
 * ganze Migration hängt: **Idempotenz**. Der zweite Lauf wird simuliert, indem
 * das Ergebnis des ersten als `existing` zurückgefüttert wird; der Plan muss
 * dann leer sein.
 */
const assert = require('node:assert');

const { planHarnessMigration, summarisePlan } = require('../dist/harness/harness-migrate');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

const P1 = '69c12580c01a0739c142f1c0';
const C1 = '69c0fee89970b0733871b663';

/** Ergebnis eines Laufs als `existing` für den nächsten. */
function asExisting(plan) {
  return plan.levels.map((level) => ({
    scope: level.scope,
    projectId: level.projectId,
    customerId: level.customerId,
    sectionKeys: level.sections.map((s) => s.key),
  }));
}

const fullSoul = {
  vision: 'V', principles: 'P', conventions: 'C',
  communication: 'K', boundaries: 'B', workflow: 'W', quality: 'Q',
};

check('Projekt-Soul ergibt sieben Sections mit den bisherigen Feldnamen als Key', () => {
  const plan = planHarnessMigration({
    souls: [{ projectId: P1, fields: fullSoul }],
    projects: [],
    existing: [],
  });
  assert.strictEqual(plan.levels.length, 1);
  assert.strictEqual(plan.levels[0].scope, 'project');
  assert.deepStrictEqual(
    plan.levels[0].sections.map((s) => s.key),
    ['vision', 'principles', 'conventions', 'communication', 'boundaries', 'workflow', 'quality'],
  );
  assert.ok(plan.levels[0].sections.every((s) => s.kind === 'prose' && s.mergeStrategy === 'replace'));
});

check('Kunden-Souls werden ebenso migriert', () => {
  const plan = planHarnessMigration({
    souls: [{ customerId: C1, fields: { vision: 'V' } }],
    projects: [],
    existing: [],
  });
  assert.strictEqual(plan.levels.length, 1);
  assert.strictEqual(plan.levels[0].scope, 'customer');
  assert.strictEqual(plan.levels[0].customerId, C1);
});

check('leere Soul-Felder erzeugen keine leeren Sections', () => {
  const plan = planHarnessMigration({
    souls: [{ projectId: P1, fields: { vision: 'V', principles: '', conventions: '   ', quality: null } }],
    projects: [],
    existing: [],
  });
  assert.deepStrictEqual(plan.levels[0].sections.map((s) => s.key), ['vision']);
  // Auf die Projektebene eingegrenzt: die globale `tool-usage` wird hier
  // ebenfalls als leer übersprungen (kein agentInstructions im Input) und
  // zaehlte sonst mit.
  const emptyOnProject = plan.skipped.filter((s) => s.reason === 'empty' && s.scope === 'project');
  assert.deepStrictEqual(
    emptyOnProject.map((s) => s.key).sort(),
    ['boundaries', 'communication', 'conventions', 'principles', 'quality', 'workflow'],
  );
});

check('komplett leerer Soul erzeugt gar keinen Harness', () => {
  const plan = planHarnessMigration({
    souls: [{ projectId: P1, fields: { vision: '', quality: '  ' } }],
    projects: [],
    existing: [],
  });
  assert.deepStrictEqual(plan.levels, []);
});

check('agent_instructions landet vollständig im globalen Harness', () => {
  const text = 'A'.repeat(5000);
  const plan = planHarnessMigration({ souls: [], projects: [], agentInstructions: text, existing: [] });
  const global = plan.levels.find((l) => l.scope === 'global');
  assert.ok(global, 'globale Ebene fehlt');
  assert.strictEqual(global.sections[0].key, 'tool-usage');
  assert.strictEqual(global.sections[0].body.length, 5000, 'Text darf nicht gekürzt werden');
});

check('project.instructions wird zur Section instructions', () => {
  const plan = planHarnessMigration({
    souls: [],
    projects: [{ id: P1, instructions: 'Kontext des Projekts' }],
    existing: [],
  });
  assert.deepStrictEqual(plan.levels[0].sections.map((s) => s.key), ['instructions']);
  assert.strictEqual(plan.levels[0].sections[0].body, 'Kontext des Projekts');
});

check('instructions und Soul landen als getrennte Sections auf derselben Ebene', () => {
  const plan = planHarnessMigration({
    souls: [{ projectId: P1, fields: { conventions: 'aus dem Soul' } }],
    projects: [{ id: P1, instructions: 'aus den instructions' }],
    existing: [],
  });
  assert.strictEqual(plan.levels.length, 1, 'beides gehört auf dieselbe Projektebene');
  assert.deepStrictEqual(plan.levels[0].sections.map((s) => s.key), ['instructions', 'conventions']);
});

check('IDEMPOTENZ: zweiter Lauf plant nichts mehr', () => {
  const input = {
    souls: [{ projectId: P1, fields: fullSoul }, { customerId: C1, fields: { vision: 'V' } }],
    projects: [{ id: P1, instructions: 'Kontext' }],
    agentInstructions: 'global',
    existing: [],
  };
  const first = planHarnessMigration(input);
  assert.ok(summarisePlan(first).sections > 0, 'erster Lauf muss etwas planen');

  const second = planHarnessMigration({ ...input, existing: asExisting(first) });
  assert.deepStrictEqual(second.levels, [], 'zweiter Lauf darf nichts planen');
  assert.strictEqual(
    summarisePlan(second).skippedExisting,
    summarisePlan(first).sections,
    'jede Section des ersten Laufs muss als "existiert bereits" gemeldet werden',
  );
});

check('vorhandene Sections werden nicht überschrieben, fehlende ergänzt', () => {
  const plan = planHarnessMigration({
    souls: [{ projectId: P1, fields: { vision: 'neu', quality: 'auch neu' } }],
    projects: [],
    existing: [{ scope: 'project', projectId: P1, sectionKeys: ['vision'] }],
  });
  assert.deepStrictEqual(plan.levels[0].sections.map((s) => s.key), ['quality']);
  assert.deepStrictEqual(
    plan.skipped.filter((s) => s.reason === 'exists').map((s) => s.key),
    ['vision'],
  );
});

check('Soul ohne Owner wird übersprungen statt in eine kaputte Ebene zu laufen', () => {
  const plan = planHarnessMigration({
    souls: [{ fields: fullSoul }],
    projects: [],
    existing: [],
  });
  assert.deepStrictEqual(plan.levels, []);
});

check('fremde Felder des Soul-Dokuments werden nicht mitmigriert', () => {
  const plan = planHarnessMigration({
    souls: [{ projectId: P1, fields: { ...fullSoul, _id: 'x', __v: 0, createdAt: 'egal' } }],
    projects: [],
    existing: [],
  });
  assert.strictEqual(plan.levels[0].sections.length, 7, 'nur die sieben Soul-Felder');
});

check('summarisePlan zählt Ebenen, Sections und beide Übersprungen-Gründe', () => {
  const plan = planHarnessMigration({
    souls: [{ projectId: P1, fields: { vision: 'V', quality: '' } }],
    projects: [],
    agentInstructions: 'g',
    existing: [{ scope: 'global', sectionKeys: ['tool-usage'] }],
  });
  const s = summarisePlan(plan);
  assert.deepStrictEqual(s, { levels: 1, sections: 1, skippedEmpty: 6, skippedExisting: 1 });
});

console.log(`\n${passed} Prüfungen bestanden.`);
