import { isUnknownArray, idToString } from '../common/tool-args';
import { asDate, isRecord } from './replication-narrow.helpers';
import { SyncLogEntry } from './replication-sync.types';

/** Parse a Mongo date-ish value to ms epoch, or null. Nur Date, String und
 *  Number sind sinnvolle Eingaben — alles andere ergäbe ein Invalid Date, das
 *  über den NaN-Zweig ohnehin zu `null` geworden wäre. Identisch zum `toMs()`
 *  des Log-Writers. */
export function toMs(value: unknown): number | null {
  return asDate(value)?.getTime() ?? null;
}

/**
 * Map a raw replication_log document to the wire shape. Drops Mongo-internal
 * fields (_id, createdAt, updatedAt) the receiver doesn't need.
 *
 * Die Quelle ist immer das **lokale** replication_log, dessen Felder der
 * Log-Writer schreibt: `projectId`/`projectIds` sind dort per Schema Strings,
 * `document` ist ein Objekt oder null. Die Prüfungen hier verengen also nichts,
 * was im Normalbetrieb vorkommt — sie ersetzen nur die bisherigen Behauptungen
 * durch belegte Verengungen. Wichtig: `projectIds` behält seine Länge (nicht
 * lesbare Elemente werden zu `''`, nicht weggefiltert), damit kein Projektbezug
 * unbemerkt aus einem Multi-Projekt-Eintrag verschwindet.
 */
export function toSyncEntry(logDoc: Record<string, unknown>): SyncLogEntry {
  return {
    seq: Number(logDoc.seq),
    eventId: String(logDoc.eventId),
    op: logDoc.op === 'delete' ? 'delete' : 'upsert',
    collection: String(logDoc.collection),
    documentId: String(logDoc.documentId),
    projectId: idToString(logDoc.projectId) ?? null,
    projectIds: isUnknownArray(logDoc.projectIds)
      ? logDoc.projectIds.map((p) => idToString(p) ?? '')
      : null,
    document: isRecord(logDoc.document) ? logDoc.document : null,
    updatedAtMs: logDoc.updatedAtMs == null ? null : Number(logDoc.updatedAtMs),
    deletedAtMs: logDoc.deletedAtMs == null ? null : Number(logDoc.deletedAtMs),
    originInstanceId: String(logDoc.originInstanceId),
  };
}

/**
 * Build a pull page from a window of log entries (already sorted by seq asc,
 * already fetched with `limit+? `). Keeps only locally-originated entries
 * (origin === self) — the 2-instance echo filter. `nextSince` is the MAX seq
 * in the scanned window (incl. filtered-out entries) so the caller advances
 * past server-side skips. `hasMore` is true iff the window was full (== limit).
 */
export function pullPage(
  entries: SyncLogEntry[],
  selfInstanceId: string,
  limit: number,
): { page: SyncLogEntry[]; nextSince: number; hasMore: boolean } {
  const scanned = entries.slice(0, limit);
  const page = scanned.filter((e) => e.originInstanceId === selfInstanceId);
  const nextSince = scanned.length > 0 ? scanned[scanned.length - 1].seq : 0;
  const hasMore = scanned.length === limit;
  return { page, nextSince, hasMore };
}
