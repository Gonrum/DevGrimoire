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

/** Pfade, die nach Export-Key schlüsseln (Full-Sync). Eigener Namensraum,
 *  aber dieselbe Lücke — T-466. */
const KEYED_BY_EXPORT = [
  'replication-full-sync.service.ts',
  'replication-receive.service.ts',
];

/**
 * Die Export-Keys sind Übertragungsformat: sie stehen als Objektschlüssel im
 * Full-Sync-Payload zwischen zwei Instanzen. Wer einen davon umbenennt, bricht
 * den Sync gegen jede nicht gleichzeitig aktualisierte Gegenstelle — und zwar
 * still, weil der Empfänger unbekannte Keys überspringt. Diese Tabelle friert
 * den Bestand ein.
 */
const WIRE_KEYS = {
  project: 'projects',
  todos: 'todos',
  sessions: 'sessions',
  knowledge: 'knowledges',
  changelog: 'changelogs',
  milestones: 'milestones',
  manuals: 'manuals',
  research: 'researches',
  environments: 'environments',
  secrets: 'secrets',
  schemas: 'dbschemas',
  dependencies: 'dependencies',
  features: 'features',
  souls: 'souls',
  commits: 'commits',
  recurringTasks: 'recurringtasks',
  snippets: 'snippets',
  attachments: 'attachments',
  activities: 'activities',
  releases: 'releases',
};

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

// 4) Full-Sync: dieselbe Ableitung, eigener Namensraum.
check('registry exportiert EXPORT_COLLECTION', () => {
  assert.ok(reg.EXPORT_COLLECTION, 'EXPORT_COLLECTION wird nicht exportiert');
});

check('EXPORT_COLLECTION deckt jede registrierte Collection ab', () => {
  const map = reg.EXPORT_COLLECTION || {};
  const covered = new Set(Object.values(map));
  const missing = reg.REPLICATED_COLLECTIONS
    .map((c) => c.collection)
    .filter((c) => !covered.has(c));
  assert.deepEqual(missing, [], `nicht abgedeckt: ${missing.join(', ')}`);
});

check('bestehende Export-Keys unverändert (Übertragungsformat)', () => {
  const map = reg.EXPORT_COLLECTION || {};
  const broken = [];
  for (const [key, coll] of Object.entries(WIRE_KEYS)) {
    if (map[key] !== coll) broken.push(`${key}: ${map[key] ?? '<fehlt>'} statt ${coll}`);
  }
  assert.deepEqual(broken, [], `Wire-Format verletzt — ${broken.join('; ')}`);
});

check('Export-Keys sind eindeutig', () => {
  const map = reg.EXPORT_COLLECTION || {};
  const colls = Object.values(map);
  const dup = colls.filter((c, i) => colls.indexOf(c) !== i);
  assert.deepEqual(dup, [], `zwei Keys auf dieselbe Collection: ${dup.join(', ')}`);
});

for (const file of KEYED_BY_EXPORT) {
  check(`${file} führt keine eigene Export-Tabelle`, () => {
    const src = fs.readFileSync(path.join(SRC, file), 'utf8');
    const literal = /const\s+(SYNC_COLLECTIONS|exportCollectionMap)\s*:\s*Record<string,\s*string>\s*=\s*\{/.exec(src);
    assert.equal(
      literal,
      null,
      `lokales Literal ${literal && literal[1]} — muss aus replication-collections stammen`,
    );
  });
}

console.log(failed === 0 ? '\nalle Prüfungen grün' : `\n${failed} Prüfung(en) rot`);
process.exit(failed === 0 ? 0 : 1);
