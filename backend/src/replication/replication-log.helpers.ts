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

/** Instanz-Ids beider Seiten für den Tie-Break in `compareLww`. */
export interface LwwTieBreak {
  /** Die eigene Instanz (der Empfänger). */
  localInstanceId: string | null | undefined;
  /** Die Instanz, von der die eingehende Änderung stammt. */
  incomingInstanceId: string | null | undefined;
}

/**
 * Last-Write-Wins decision. A missing local timestamp always applies (better
 * to overwrite an undated doc than silently lose an update). A missing
 * incoming timestamp also applies (we cannot prove it is older).
 *
 * Gleichstand (H-34): „equal timestamps apply" war nur unidirektional
 * harmlos. Im Peer-Mode wenden BEIDE Seiten an — bearbeiten A und B dasselbe
 * Dokument in derselben Millisekunde, tauschen sie ihre Inhalte, und weil
 * danach beide `updatedAt = T` tragen, korrigiert nichts mehr (auch kein
 * Full-Sync). Deshalb ein deterministischer Tie-Break, der auf beiden Seiten
 * dieselbe Regel ist: die lexikographisch HÖHERE Instanz-Id gewinnt. A wendet
 * Bs Version genau dann an, wenn B > A; B wendet As Version genau dann an,
 * wenn A > B — genau eine Seite übernimmt, beide konvergieren.
 *
 * Ohne beide Ids (alter Peer, Instanz-Id noch nicht gesetzt) bleibt das alte
 * Verhalten: apply. Eine erneut zugestellte identische Version, die dadurch
 * übersprungen wird, ist inhaltsgleich — kein Verlust.
 */
export function compareLww(
  localUpdatedAtMs: number | null,
  incomingUpdatedAtMs: number | null,
  tieBreak?: LwwTieBreak,
): 'apply' | 'skip' {
  if (localUpdatedAtMs == null) return 'apply';
  if (incomingUpdatedAtMs == null) return 'apply';
  if (localUpdatedAtMs > incomingUpdatedAtMs) return 'skip';
  if (localUpdatedAtMs < incomingUpdatedAtMs) return 'apply';
  const local = tieBreak?.localInstanceId;
  const incoming = tieBreak?.incomingInstanceId;
  if (!local || !incoming || local === incoming) return 'apply';
  return incoming > local ? 'apply' : 'skip';
}
