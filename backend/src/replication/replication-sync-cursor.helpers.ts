import { SyncLogEntry } from './replication-sync.types';

/**
 * Push send-set selection (2-instance echo filter, spec §6.1). An entry is
 * pushed to the peer iff it originated LOCALLY (origin === self) AND its
 * project is opted-in. Peer-origin entries (pulled + applied, tagged remote via
 * replication_applied) are excluded → no echo. Entries with no projectId or a
 * non-enabled project are excluded (confidentiality). For fan-out (>2
 * instances) switch the origin test to `origin !== recipient`.
 */
export function selectSendSet(
  entries: SyncLogEntry[],
  selfInstanceId: string,
  enabledProjectIds: Set<string>,
): SyncLogEntry[] {
  return entries.filter(
    (e) =>
      e.originInstanceId === selfInstanceId &&
      e.projectId != null &&
      enabledProjectIds.has(e.projectId),
  );
}

/**
 * New outbound cursor after a push batch. Crash-safe: advance ONLY over entries
 * the receiver durably handled (spec §6.1 step 4, §6.3).
 *  - Pure-skip window (nothing to send, maxSentSeq == null): jump to
 *    windowMaxSeq — those entries never go over the wire, no round-trip needed.
 *  - Receiver handled everything we sent (appliedThrough >= maxSentSeq): jump to
 *    windowMaxSeq — trailing skips above the last sent seq are covered too.
 *  - Otherwise (a poison entry stopped the receiver's contiguous run): advance
 *    only to appliedThrough, never below the current cursor. The blocking entry
 *    is retried next cycle (deadletter unblocks it in Plan 3).
 */
export function advanceOutbound(
  windowMaxSeq: number,
  maxSentSeq: number | null,
  appliedThrough: number,
  currentCursor: number,
): number {
  if (maxSentSeq == null) return windowMaxSeq;
  if (appliedThrough >= maxSentSeq) return windowMaxSeq;
  return Math.max(currentCursor, appliedThrough);
}

/** One applied inbound entry's outcome (seq + whether it was terminally handled). */
export interface InboundResult {
  seq: number;
  handled: boolean;
}

/**
 * New inbound cursor after applying a pulled page (spec §6.2 step 3). `results`
 * are in seq order. Walk the contiguous run of handled entries from the front:
 *  - All handled (or empty page): jump to `nextSince` (the server's max scanned
 *    seq — includes server-side skips, so we never re-scan them).
 *  - A poison entry broke the run: advance only to the last handled seq, never
 *    below the current cursor. The rest is re-pulled next cycle.
 */
export function advanceInbound(
  results: InboundResult[],
  nextSince: number,
  currentCursor: number,
): number {
  let frontier = currentCursor;
  let broke = false;
  for (const r of results) {
    if (broke) break;
    if (r.handled) frontier = r.seq;
    else broke = true;
  }
  if (!broke) return Math.max(currentCursor, nextSince);
  return Math.max(currentCursor, frontier);
}

/**
 * Whether an apply skip-reason is TERMINAL (the entry is permanently handled;
 * the cursor may advance past it) vs a transient apply error (db/throw — the
 * cursor must stop so the entry is retried). Shared by the receive endpoint
 * (appliedThrough) and the pull-side driver (inbound cursor). The matched
 * substrings mirror the reason strings produced by
 * replication-sync-apply.service.ts. (Plan 3 replaces this string heuristic
 * with structured result codes.)
 */
export function isTerminalSkip(reason?: string): boolean {
  if (!reason) return false;
  return (
    reason.startsWith('LWW') ||
    reason.includes('not replication-enabled') ||
    reason.includes('bootstrap required') ||
    reason.includes('own origin') ||
    reason.includes('not a replicated collection') ||
    reason.includes('no projectId') ||
    reason.includes('invalid documentId') ||
    reason.includes('no document')
  );
}
