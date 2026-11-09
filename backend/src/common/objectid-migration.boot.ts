import { Logger } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { errorMessage } from './narrow';
import { migrateObjectIds, OBJECTID_MIGRATION_ID, pathsByCollection } from './objectid-migration';

const logger = new Logger('ObjectIdMigration');

/**
 * T-510: einmaliger Start-Lauf der ObjectId-Migration.
 *
 * Läuft in `main.ts` direkt nach `NestFactory.create` — also nachdem alle
 * Modelle registriert sind, aber bevor `listen` die `onModuleInit`-Hooks
 * (die teils selbst abfragen), Cron-Jobs und Requests startet. Nur so sieht
 * keine Abfrage den Zwischenzustand „Schema castet, Daten noch String".
 *
 * Nach einem vollständigen Lauf steht ein Marker in `migrations`; danach kostet
 * der Start nur ein `findOne`. Ein Fehler verhindert den Start nicht (laut
 * loggen, Marker nicht setzen → nächster Start versucht es erneut). Messen und
 * gezielt nachziehen: `npm run objectid:migrate` (Trockenlauf).
 */
export async function runObjectIdMigrationOnce(connection: Connection): Promise<void> {
  const db = connection.db;
  if (!db) return;
  const markers = db.collection<{ _id: string; doneAt: Date; written: number; uncastable: number }>('migrations');
  try {
    if (await markers.findOne({ _id: OBJECTID_MIGRATION_ID })) return;
    const started = Date.now();
    const report = await migrateObjectIds(db, pathsByCollection(Object.values(connection.models)), { apply: true });
    let written = 0;
    let uncastable = 0;
    for (const r of report) {
      written += r.written;
      for (const p of Object.values(r.paths)) uncastable += p.uncastable;
      if (r.raced > 0) logger.warn(`${r.collection}: ${r.raced} Dokument(e) zwischenzeitlich geändert, übersprungen`);
      if (r.conflicts.length > 0) {
        logger.warn(`${r.collection}: Unique-Konflikt, unverändert gelassen: ${r.conflicts.join(', ')}`);
      }
    }
    logger.log(
      `String-Referenzen → ObjectId: ${written} Dokument(e) in ${report.length} Collection(s), ` +
        `${uncastable} unwandelbare Werte belassen (${Date.now() - started} ms)`,
    );
    await markers.updateOne(
      { _id: OBJECTID_MIGRATION_ID },
      { $set: { doneAt: new Date(), written, uncastable } },
      { upsert: true },
    );
  } catch (err) {
    logger.error(`ObjectId-Migration fehlgeschlagen, nächster Start versucht es erneut: ${errorMessage(err)}`);
  }
}
