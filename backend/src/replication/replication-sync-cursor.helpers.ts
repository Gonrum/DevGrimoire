import { SyncLogEntry, ApplyOutcome } from './replication-sync.types';

/**
 * Push send-set selection (2-instance echo filter, spec §6.1). An entry is
 * pushed to the peer iff it originated LOCALLY (origin === self) AND its
 * project is opted-in. Peer-origin entries (pulled + applied, tagged remote via
 * replication_applied) are excluded → no echo. Entries with no projectId or a
 * non-enabled project are excluded (confidentiality). For fan-out (>2
 * instances) switch the origin test to `origin !== recipient`.
 * `excludeEventIds` — Einträge, die push-seitig deadlettert wurden
 * (Kontiguitäts-Auflösung, Plan 3a) → nicht erneut senden.
 */
/** Effective project references of a log entry: the single `projectId` if set,
 *  else the multi-project `projectIds` array (e.g. ResearchTopic), else empty. */
export function entryProjectIds(entry: {
  projectId: string | null;
  projectIds?: string[] | null;
}): string[] {
  if (entry.projectId != null) return [entry.projectId];
  return entry.projectIds ?? [];
}

/** Opt-in test: an entry is replicated iff AT LEAST ONE of its projects is
 *  locally enabled. Multi-project entities touching one enabled project sync
 *  even if they also reference disabled ones. No projects → never replicated. */
export function isEntryOptedIn(
  entry: { projectId: string | null; projectIds?: string[] | null },
  enabledProjectIds: Set<string>,
): boolean {
  return entryProjectIds(entry).some((p) => enabledProjectIds.has(p));
}

export function selectSendSet(
  entries: SyncLogEntry[],
  selfInstanceId: string,
  enabledProjectIds: Set<string>,
  excludeEventIds?: Set<string>,
): SyncLogEntry[] {
  return entries.filter(
    (e) =>
      e.originInstanceId === selfInstanceId &&
      isEntryOptedIn(e, enabledProjectIds) &&
      !(excludeEventIds && excludeEventIds.has(e.eventId)),
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
 * Whether an apply outcome is TERMINAL — the entry is permanently handled and
 * the cursor may advance past it. Only `error_transient` (a db throw / transient
 * apply failure) is non-terminal → the cursor must stop so the entry is retried
 * (and eventually deadlettered after MAX_APPLY_ATTEMPTS). Replaces the earlier
 * reason-string substring heuristic.
 */
export function isTerminalOutcome(outcome: ApplyOutcome): boolean {
  return outcome !== 'error_transient';
}
