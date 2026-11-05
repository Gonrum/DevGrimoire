#!/usr/bin/env node
/**
 * Umschlüsseln aller gespeicherten Chiffrate auf einen neuen
 * SECRETS_ENCRYPTION_KEY (T-467).
 *
 * Standard ist der TROCKENLAUF: zählt pro Collection, was mit dem alten
 * Schlüssel lesbar ist (wird umgeschlüsselt), was schon mit dem neuen lesbar
 * ist (nichts zu tun) und was mit keinem lesbar ist (wird nie angefasst —
 * typischerweise von der Gegenseite replizierte Secrets). Werte und Schlüssel
 * werden nie ausgegeben, nur SHA-256-Präfixe der Schlüssel.
 *
 * Die Entscheidung trifft `planDocument()` in `dist/common/reencrypt.js` (reine
 * Funktion, Unit-Check `check:secrets-reencrypt`). Dieses Skript liest,
 * schreibt und berichtet.
 *
 * Idempotent: ein zweiter Lauf findet nur noch `new`. Jeder Schreibvorgang ist
 * an den alten Wert gebunden (`{_id, <pfad>: alt}`), ein zwischenzeitlich
 * geänderter Wert wird übersprungen statt überschrieben.
 *
 * Aufruf (vom Host aus, MONGODB_URI mit `localhost` statt `mongodb`):
 *   NEW_SECRETS_ENCRYPTION_KEY=<64 hex> node scripts/secrets-reencrypt.cjs
 *   NEW_SECRETS_ENCRYPTION_KEY=<64 hex> node scripts/secrets-reencrypt.cjs --apply
 *
 * Optional:
 *   OLD_SECRETS_ENCRYPTION_KEY  Default: SECRETS_ENCRYPTION_KEY aus Umgebung/.env
 *   --collections a,b           nur diese Collections
 *   --show-unreadable           listet Collection/_id/Pfad der unlesbaren Werte
 *
 * ABLAUF für einen echten Tausch — NICHT ohne Backup:
 *   1. Backup der Datenbank (mongodump).
 *   2. Replikation anhalten (sonst wandern halb umgeschlüsselte Stände).
 *   3. Trockenlauf, Zahlen prüfen.
 *   4. Backend stoppen, `--apply`, dann SECRETS_ENCRYPTION_KEY in .env auf den
 *      neuen Wert setzen und Backend starten.
 *   5. Stichprobe: ein Secret per secret_get lesen; Trockenlauf erneut → nur `new`.
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const mongoose = require('mongoose');

const { planDocument, parseKey } = require('../dist/common/reencrypt');

const APPLY = process.argv.includes('--apply');
const SHOW_UNREADABLE = process.argv.includes('--show-unreadable');
const collectionsArg = (() => {
  const i = process.argv.indexOf('--collections');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;
})();

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

const fingerprint = (key) => crypto.createHash('sha256').update(key.toString('hex')).digest('hex').slice(0, 8);

async function main() {
  const dotenv = readDotEnv();
  const uri = process.env.MONGODB_URI || dotenv.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI nicht gesetzt und nicht in .env');
  const oldKey = parseKey(process.env.OLD_SECRETS_ENCRYPTION_KEY || process.env.SECRETS_ENCRYPTION_KEY || dotenv.SECRETS_ENCRYPTION_KEY, 'OLD_SECRETS_ENCRYPTION_KEY');
  const newKey = parseKey(process.env.NEW_SECRETS_ENCRYPTION_KEY, 'NEW_SECRETS_ENCRYPTION_KEY');
  if (oldKey.equals(newKey)) throw new Error('Alter und neuer Schlüssel sind identisch — nichts zu tun.');

  console.log(`Modus: ${APPLY ? 'APPLY (schreibt)' : 'Trockenlauf (schreibt nichts)'}`);
  console.log(`alter Schlüssel sha256:${fingerprint(oldKey)}…  neuer Schlüssel sha256:${fingerprint(newKey)}…`);

  await mongoose.connect(uri, { directConnection: true });
  const db = mongoose.connection.db;
  const all = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();
  const names = collectionsArg ? all.filter((n) => collectionsArg.includes(n)) : all;
  if (collectionsArg) {
    const missing = collectionsArg.filter((n) => !all.includes(n));
    if (missing.length) console.log(`(nicht vorhanden, übersprungen: ${missing.join(', ')})`);
  }

  const totals = { old: 0, new: 0, unreadable: 0, written: 0, raced: 0 };
  const unreadable = [];
  for (const name of names) {
    const coll = db.collection(name);
    const counts = { old: 0, new: 0, unreadable: 0, written: 0, raced: 0 };
    for await (const doc of coll.find({})) {
      const found = planDocument(doc, oldKey, newKey);
      for (const f of found) {
        counts[f.state] += 1;
        if (f.state === 'unreadable') unreadable.push(`${name} ${String(doc._id)} ${f.path}`);
        if (f.state !== 'old' || !APPLY) continue;
        const current = f.path.split('.').reduce((n, k) => (n == null ? n : n[k]), doc);
        const res = await coll.updateOne({ _id: doc._id, [f.path]: current }, { $set: { [f.path]: f.replacement } });
        if (res.modifiedCount === 1) counts.written += 1;
        else counts.raced += 1;
      }
    }
    if (counts.old + counts.new + counts.unreadable === 0) continue;
    console.log(
      `${name.padEnd(36)} alt:${String(counts.old).padStart(5)}  neu:${String(counts.new).padStart(5)}  unlesbar:${String(counts.unreadable).padStart(5)}` +
        (APPLY ? `  geschrieben:${counts.written}${counts.raced ? `  übersprungen(geändert):${counts.raced}` : ''}` : ''),
    );
    for (const k of Object.keys(totals)) totals[k] += counts[k];
  }

  console.log(
    `\nSumme: alt ${totals.old}, neu ${totals.new}, unlesbar ${totals.unreadable}` +
      (APPLY ? `, geschrieben ${totals.written}, übersprungen ${totals.raced}` : ''),
  );
  if (totals.unreadable > 0) {
    console.log('Unlesbare Werte werden nie angefasst (mit keinem der beiden Schlüssel zu entschlüsseln).');
    if (SHOW_UNREADABLE) for (const line of unreadable) console.log(`  ${line}`);
    else console.log('  --show-unreadable listet Collection/_id/Pfad.');
  }
  if (!APPLY) console.log('\nTrockenlauf: nichts geschrieben. Mit --apply ausführen (vorher Backup!).');
  else console.log('\nJetzt SECRETS_ENCRYPTION_KEY in .env auf den neuen Schlüssel setzen und das Backend neu starten.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err && err.message ? err.message : err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
