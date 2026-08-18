#!/usr/bin/env node
/**
 * Allowlist-Erweiterung des Briefing-Modes (T-416, M-49).
 *
 * Die sicherheitsrelevante Eigenschaft ist nicht "die drei Tools kommen dazu",
 * sondern **dass es eine Vereinigung ist und keine Zuweisung**. Wäre es eine
 * Zuweisung, überschriebe ein eingeschalteter Briefing-Mode jede Rollen- oder
 * Admin-Beschränkung — aus einem Komfort-Schalter würde ein Generalschlüssel.
 */
const assert = require('node:assert');

const { extendAllowlistForBriefing, BRIEFING_EXTRA_TOOLS } = require('../dist/chat/chat.controller');

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

check('die drei Briefing-Tools kommen dazu', () => {
  const out = extendAllowlistForBriefing([]);
  assert.deepStrictEqual([...out].sort(), [...BRIEFING_EXTRA_TOOLS].sort());
});

check('BESTEHENDE Eintraege bleiben erhalten — Vereinigung, keine Zuweisung', () => {
  const before = ['todo_list', 'knowledge_search'];
  const out = extendAllowlistForBriefing(before);
  for (const t of before) {
    assert.ok(out.includes(t), `${t} darf nicht verschwinden`);
  }
  assert.strictEqual(out.length, before.length + BRIEFING_EXTRA_TOOLS.length);
});

check('keine Duplikate, wenn ein Tool schon drin ist', () => {
  const out = extendAllowlistForBriefing(['milestone_create_with_todos', 'todo_list']);
  const count = out.filter((t) => t === 'milestone_create_with_todos').length;
  assert.strictEqual(count, 1, 'doppelter Eintrag');
  assert.ok(out.includes('todo_list'));
});

check('die Eingabe wird nicht veraendert', () => {
  // Eine mutierte Allowlist wuerde sich in den Aufrufer zurueckschreiben und
  // dort auch ohne Briefing-Mode gelten.
  const before = ['todo_list'];
  extendAllowlistForBriefing(before);
  assert.deepStrictEqual(before, ['todo_list']);
});

check('keine anderen Tools werden freigeschaltet', () => {
  const out = extendAllowlistForBriefing([]);
  const unexpected = out.filter((t) => !BRIEFING_EXTRA_TOOLS.includes(t));
  assert.deepStrictEqual(unexpected, [], `unerwartet freigeschaltet: ${unexpected.join(', ')}`);
});

check('milestone_import_preview ist dabei, obwohl es nur liest', () => {
  // Es steht in tasks_write (Allowlist-Gruppierung), mutiert aber nichts —
  // deshalb ist es KEIN Write-Tool und loest keine Bestaetigung aus.
  const { WRITE_TOOL_NAMES } = require('../dist/chat/chat-tools');
  assert.ok(BRIEFING_EXTRA_TOOLS.includes('milestone_import_preview'));
  assert.ok(!WRITE_TOOL_NAMES.has('milestone_import_preview'),
    'preview darf nicht als schreibend gelten, sonst fragt der Dialog beim blossen Vorschauen');
});

check('die beiden anderen Briefing-Tools sind schreibend und damit bestaetigungspflichtig', () => {
  const { WRITE_TOOL_NAMES } = require('../dist/chat/chat-tools');
  for (const t of ['milestone_create_with_todos', 'milestone_import_apply']) {
    assert.ok(WRITE_TOOL_NAMES.has(t), `${t} muss schreibend sein, sonst laeuft es ohne Rueckfrage`);
  }
});

console.log(`\n${passed} Prüfungen bestanden.`);
