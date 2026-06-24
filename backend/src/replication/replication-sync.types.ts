/**
 * Wire shape of one replication_log entry as transferred between instances.
 * Mirrors the ReplicationLog schema fields the receiver needs (seq stays the
 * SENDER's seq — the receiver uses it only for ordering + appliedThrough acks,
 * never as its own cursor).
 */
export interface SyncLogEntry {
  seq: number;
  eventId: string;
  op: 'upsert' | 'delete';
  collection: string;
  documentId: string;
  projectId: string | null;
  document: Record<string, unknown> | null;
  updatedAtMs: number | null;
  deletedAtMs: number | null;
  originInstanceId: string;
}

/** Body of POST /sync/receive. */
export interface SyncReceiveRequest {
  sourceInstanceId: string;
  entries: SyncLogEntry[];
}

/** Per-entry apply outcome (drives appliedThrough + the sender's deadletter in Plan 3). */
export interface SyncEntryResult {
  seq: number;
  applied: boolean;
  reason?: string;
}

/** Response of POST /sync/receive. `appliedThrough` = highest CONTIGUOUSLY
 *  handled seq (applied OR deliberately skipped via LWW/opt-in); the sender
 *  advances its outbound cursor to it. `results` carries per-entry detail. */
export interface SyncReceiveResponse {
  appliedThrough: number;
  results: SyncEntryResult[];
}

/** Response of GET /sync/pull. `nextSince` = highest seq SCANNED (incl.
 *  server-side skips) so the caller never re-scans; `hasMore` signals another page. */
export interface SyncPullResponse {
  entries: SyncLogEntry[];
  nextSince: number;
  hasMore: boolean;
}
