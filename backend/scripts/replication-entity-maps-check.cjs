#!/usr/bin/env node
/*
 * Guard: die Replikationspfade dürfen keine eigene Entity→Collection-Tabelle
 * führen. `replication-collections.ts` bezeichnet sich selbst als "single
 * source of truth ... consolidating the previously scattered maps (push:
 * ENTITY_COLLECTION, events-bus: COLLECTION_ENTITY_MAP, full-sync:
 * SYNC_COLLECTIONS)" — die Zusammenführung war aber nie vollzogen.
 *
 * Der reale Schaden (T-465): `harness` stand in der Registry, fehlte aber in
 * push, receive und pull. `buildPayload()` liefert für ein unbekanntes Entity
 * `null`, und der Handler kehrt daraufhin **ohne Log und ohne
 * Warteschlangen-Eintrag** zurück — die Änderung verschwand spurlos. Betroffen
 * waren acht Entity-Typen, nicht nur harness.
 *
 * Der bestehende `replication-collections-guard` prüft Schemas GEGEN die
 * Registry. Dieser hier prüft die Registry gegen die CODEPFADE — die Lücke,
 * durch die der Fehler fiel.
 *
 * Prüft SOURCE (nicht dist), damit ein wieder eingeführtes lokales Literal
 * sofort auffällt.
 *
 * Aufruf: `npm run check:replication-entity-maps` (nach dem Build).
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const reg = loadCompiled('replication/replication-collections.js');
const SRC = path.resolve(__dirname, '..', 'src', 'replication');

/** Pfade, die nach Entity-Namen schlüsseln. Full-Sync bleibt aussen vor: der
 *  schlüsselt nach Export-Keys (`todos`, `knowledge`) — ein anderer
 *  Namensraum, der Teil des Übertragungsformats ist. */
const KEYED_BY_ENTITY = [
  'replication-push.service.ts',
  'replication-receive.service.ts',
  'replication.controller.ts',
];

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message.split('\n')[0]}`);
  }
}

console.log('replication entity maps');

// 1) Die Registry muss eine fertige Entity→Collection-Tabelle anbieten.
check('registry exportiert ENTITY_COLLECTION', () => {
  assert.ok(reg.ENTITY_COLLECTION, 'ENTITY_COLLECTION wird nicht exportiert');
});

// 2) ... und die muss jedes registrierte Entity abdecken, mit demselben
//    Collection-Namen.
check('ENTITY_COLLECTION deckt jede registrierte Collection ab', () => {
  const map = reg.ENTITY_COLLECTION || {};
  const missing = [];
  const wrong = [];
  for (const entry of reg.REPLICATED_COLLECTIONS) {
    if (!(entry.entity in map)) missing.push(entry.entity);
    else if (map[entry.entity] !== entry.collection) {
      wrong.push(`${entry.entity}: ${map[entry.entity]} statt ${entry.collection}`);
    }
  }
  assert.deepEqual(missing, [], `nicht abgedeckt: ${missing.join(', ')}`);
  assert.deepEqual(wrong, [], `falsch gemappt: ${wrong.join(', ')}`);
});

// 3) Kein Pfad darf sich eine eigene Tabelle danebenlegen.
for (const file of KEYED_BY_ENTITY) {
  check(`${file} führt keine eigene Tabelle`, () => {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    const literal = /const\s+(\w*ENTITY_COLLECTIONS?\w*)\s*:\s*Record<string,\s*string>\s*=\s*\{/.exec(src);
    assert.equal(
      literal,
      null,
      `lokales Literal ${literal && literal[1]} — muss aus replication-collections stammen`,
    );
  });

  check(`${file} bezieht die Tabelle aus der Registry`, () => {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    assert.match(
      src,
      /ENTITY_COLLECTION[\s\S]*from '\.\/replication-collections'/,
      'kein Import von ENTITY_COLLECTION aus replication-collections',
    );
  });
}

console.log(failed === 0 ? '\nalle Prüfungen grün' : `\n${failed} Prüfung(en) rot`);
process.exit(failed === 0 ? 0 : 1);
