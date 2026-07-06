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

/** Outcome of one sync cycle (push+pull). `skippedReason` set iff the cycle
 *  was a no-op (driver not active / no peer / already running). */
export interface SyncCycleResult {
  pushed: number;
  pulled: number;
  applied: number;
  skipped: number;
  outboundCursor: number;
  inboundCursor: number;
  skippedReason?: string;
}

/** Cursor/lag snapshot for GET /sync/status (drives the Plan 5 UI). */
export interface SyncStatus {
  driver: string;
  outboundCursor: number;
  inboundCursor: number;
  localMaxSeq: number;
  outboundLag: number;
  lastCycleAt: string | null;
  running: boolean;
}
