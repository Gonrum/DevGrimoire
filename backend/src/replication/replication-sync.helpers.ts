import { SyncLogEntry } from './replication-sync.types';

/** Parse a Mongo date-ish value to ms epoch, or null. */
export function toMs(value: unknown): number | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value as string | number);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

/** Map a raw replication_log document to the wire shape. Drops Mongo-internal
 *  fields (_id, createdAt, updatedAt) the receiver doesn't need. */
export function toSyncEntry(logDoc: Record<string, unknown>): SyncLogEntry {
  return {
    seq: Number(logDoc.seq),
    eventId: String(logDoc.eventId),
    op: logDoc.op === 'delete' ? 'delete' : 'upsert',
    collection: String(logDoc.collection),
    documentId: String(logDoc.documentId),
    projectId: logDoc.projectId == null ? null : String(logDoc.projectId),
    document: (logDoc.document as Record<string, unknown> | null) ?? null,
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
