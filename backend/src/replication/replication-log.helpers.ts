/**
 * Pure decision helpers for the replication log. No I/O — unit-tested via
 * scripts/replication-collections-units-check.cjs.
 */

/** Map a MongoDB change-stream operationType to the log op, or null to ignore. */
export function mapOperation(operationType: string): 'upsert' | 'delete' | null {
  switch (operationType) {
    case 'insert':
    case 'update':
    case 'replace':
      return 'upsert';
    case 'delete':
      return 'delete';
    default:
      return null; // drop, rename, invalidate, etc. are not replicated
  }
}

/**
 * Stable idempotency key for a captured change. Same change re-processed after
 * a crash-resume yields the same eventId → unique index dedups the insert.
 * clusterTimeMs disambiguates repeated writes to the same doc.
 */
export function deriveEventId(collection: string, documentId: string, clusterTimeMs: number): string {
  return `${collection}:${documentId}:${clusterTimeMs}`;
}

/** Loopback-suppression lookup key: identifies the exact write being applied. */
export function makeAppliedKey(collection: string, documentId: string, updatedAtMs: number): string {
  return `${collection}:${documentId}:${updatedAtMs}`;
}

/**
 * Last-Write-Wins decision. Strict `>`: equal timestamps apply the incoming
 * change (idempotent in practice). A missing local timestamp always applies
 * (better to overwrite an undated doc than silently lose an update). A missing
 * incoming timestamp also applies (we cannot prove it is older).
 */
export function compareLww(
  localUpdatedAtMs: number | null,
  incomingUpdatedAtMs: number | null,
): 'apply' | 'skip' {
  if (localUpdatedAtMs == null) return 'apply';
  if (incomingUpdatedAtMs == null) return 'apply';
  return localUpdatedAtMs > incomingUpdatedAtMs ? 'skip' : 'apply';
}
