#!/usr/bin/env node
/**
 * T-510: String-Referenzen → ObjectId messen (Trockenlauf) oder nachziehen.
 *
 * Die Logik steht in `dist/common/objectid-migration.js` und läuft auch
 * einmalig beim Start des Backends (main.ts, vor `listen`). Dieses Skript ist
 * zum MESSEN (Standard: Trockenlauf) und für gezieltes Nachziehen gedacht.
 *
 * Welche Felder: alle ObjectId-Pfade der kompilierten Schemas in `dist/`,
 * einschliesslich Arrays, verschachtelter Objekte und Subdokument-Arrays.
 * Regeln siehe `src/common/objectid-migration.ts`: 24 Hex → ObjectId,
 * '' → null, alles andere bleibt stehen und wird gemeldet; Unique-Konflikte
 * werden gemeldet statt geschrieben; idempotent.
 *
 * Aufruf (vom Host aus, MONGODB_URI mit `localhost` statt `mongodb`):
 *   node scripts/objectid-migrate.cjs              # Trockenlauf
 *   node scripts/objectid-migrate.cjs --apply      # schreibt (vorher Backup!)
 *   --collections a,b      nur diese Collections
 *   --show-uncastable      listet Collection/_id/Pfad/Wert der unwandelbaren
 *
 * Nach `npm run build` ausführen.
 */
const path = require('node:path');
const fs = require('node:fs');
const mongoose = require('mongoose');

const { migrateObjectIds, pathsByCollection } = require('../dist/common/objectid-migration');

/** Alle `*.schema.js` unter dist/ → [{ modelName, schema }] (Modellname = Klassenname, wie forFeature). */
function loadSchemas(distDir) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.schema.js')) {
        for (const [exportName, value] of Object.entries(require(p))) {
          if (!exportName.endsWith('Schema') || !(value instanceof mongoose.Schema)) continue;
          out.push({ modelName: exportName.slice(0, -'Schema'.length), schema: value });
        }
      }
    }
  };
  walk(distDir);
  return out;
}

/** Registriert die Schemas an `conn` und liefert die Modelle. */
function registerModels(conn, schemas) {
  for (const { modelName, schema } of schemas) {
    if (!conn.models[modelName]) conn.model(modelName, schema);
  }
  return Object.values(conn.models);
}

function readDotEnv() {
  const out = {};
  for (const candidate of [path.join(__dirname, '..', '..', '.env'), path.join(__dirname, '..', '.env')]) {
    if (!fs.existsSync(candidate)) continue;
    for (const line of fs.readFileSync(candidate, 'utf-8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && out[m[1]] === undefined) out[m[1]] = m[2];
    }
  }
  return out;
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  const SHOW = process.argv.includes('--show-uncastable');
  const i = process.argv.indexOf('--collections');
  const collections = i >= 0 && process.argv[i + 1] ? process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;

  const uri = process.env.MONGODB_URI || readDotEnv().MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI nicht gesetzt und nicht in .env');

  const conn = await mongoose.createConnection(uri, { directConnection: true, autoIndex: false }).asPromise();
  try {
    const byColl = pathsByCollection(registerModels(conn, loadSchemas(path.join(__dirname, '..', 'dist'))));
    const total = [...byColl.values()].reduce((n, p) => n + p.length, 0);
    console.log(`Modus: ${APPLY ? 'APPLY (schreibt)' : 'Trockenlauf (schreibt nichts)'}`);
    console.log(`${byColl.size} Collections, ${total} ObjectId-Pfade aus den Schemas\n`);
    const report = await migrateObjectIds(conn.db, byColl, { apply: APPLY, collections });
    let sumCast = 0;
    let sumUncast = 0;
    for (const r of report) {
      const applied = APPLY
        ? `, geschrieben ${r.written}${r.raced ? `, übersprungen ${r.raced}` : ''}${r.conflicts.length ? `, Unique-Konflikt ${r.conflicts.length}: ${r.conflicts.join(' ')}` : ''}`
        : '';
      console.log(`${r.collection}  (${r.docs} Dokumente${applied})`);
      for (const [p, e] of Object.entries(r.paths)) {
        sumCast += e.castable;
        sumUncast += e.uncastable;
        console.log(`  ${p.padEnd(40)} String→ObjectId: ${String(e.castable).padStart(6)}  unwandelbar: ${e.uncastable}`);
        if (SHOW) for (const s of e.samples) console.log(`      ${s.id}  ${JSON.stringify(s.value)}`);
      }
    }
    console.log(`\nSumme: wandelbar ${sumCast}, unwandelbar ${sumUncast}`);
    if (sumUncast > 0 && !SHOW) console.log('  --show-uncastable listet die unwandelbaren Werte.');
    if (!APPLY) console.log('\nTrockenlauf: nichts geschrieben. Mit --apply ausführen (vorher Backup!).');
  } finally {
    await conn.close();
  }
}

module.exports = { loadSchemas, registerModels };

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
