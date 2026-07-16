/**
 * Pure helpers for replication_log garbage collection (Plan 4). The log is the
 * durable source for outbound push AND the passive side's servePull; nothing
 * prunes it today (only `replication_applied` has a TTL index), so it grows
 * unbounded. GC deletes by age, with a safety guard that never drops
 * un-replicated local writes on the active driver.
 */

/** Default retention if unset/invalid. MUST exceed the longest expected offline
 *  window of the peer — an entry aged out before the peer consumed it is lost. */
export const DEFAULT_LOG_RETENTION_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/** Parse the configured retention (days). Falls back to the default on a
 *  missing / non-numeric / non-positive value so a fat-fingered setting can
 *  never widen deletion to "everything". */
export function resolveRetentionDays(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOG_RETENTION_DAYS;
}

/** Deletion boundary for one GC pass. An entry is prunable iff
 *  `createdAtMs < cutoffMs` AND `seq <= maxSeqInclusive`. */
export interface LogGcBound {
  cutoffMs: number;
  maxSeqInclusive: number;
}

/**
 * Compute the boundary.
 *  - Age (`cutoffMs`): now − retention.
 *  - Seq guard (`maxSeqInclusive`): on the ACTIVE driver, never delete entries
 *    the outbound push has not durably acked (`seq > outboundCursor`) — those
 *    are un-replicated local writes. A passive/unset instance has no locally
 *    known consumer cursor (the peer pulls its log and tracks the cursor
 *    remotely), so age alone bounds deletion; the operator contract is
 *    "retention > longest offline window".
 */
export function logGcBound(
  nowMs: number,
  retentionDays: number,
  isActiveDriver: boolean,
  outboundCursor: number,
): LogGcBound {
  return {
    cutoffMs: nowMs - retentionDays * MS_PER_DAY,
    maxSeqInclusive: isActiveDriver ? outboundCursor : Number.MAX_SAFE_INTEGER,
  };
}

/** Predicate mirroring the Mongo delete filter exactly — the unit check pins
 *  the guard against this so the query and the intent can't silently diverge. */
export function isPrunable(
  entry: { createdAtMs: number; seq: number },
  bound: LogGcBound,
): boolean {
  return entry.createdAtMs < bound.cutoffMs && entry.seq <= bound.maxSeqInclusive;
}
