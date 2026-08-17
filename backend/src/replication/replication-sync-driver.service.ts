import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { REPLICATION_STATUS_CHANGED } from '../events/project-event';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReplicationLog, ReplicationLogDocument } from './schemas/replication-log.schema';
import { ReplicationSyncClientService } from './replication-sync-client.service';
import { ReplicationSyncApplyService } from './replication-sync-apply.service';
import { ReplicationDeadletterService } from './replication-deadletter.service';
import { toSyncEntry } from './replication-sync.helpers';
import {
  selectSendSet,
  advanceOutbound,
  advanceInbound,
  isTerminalOutcome,
  InboundResult,
} from './replication-sync-cursor.helpers';
import {
  classifyHttpError,
  computeBackoffMs,
  deriveDirectionState,
  directionAlert,
  ErrorClass,
} from './replication-backoff.helpers';
import { errorMessage, httpErrorStatus } from './replication-narrow.helpers';
import { toPlainDoc } from '../common/tool-args';
import { SyncCycleResult, SyncStatus, SyncLogEntry, SyncReceiveResponse, DirectionHealth } from './replication-sync.types';
import {
  REPL_INSTANCE_ID,
  REPL_SYNC_DRIVER,
  REPL_CURSOR_OUTBOUND,
  REPL_CURSOR_INBOUND,
  REPL_LAST_SYNC_CYCLE,
  REPL_PEER_URL,
  REPL_BACKOFF_BASE_MS,
  REPL_BACKOFF_CAP_MS,
  REPL_OUTBOUND_NOTIFIED_STATE,
  REPL_INBOUND_NOTIFIED_STATE,
  REPL_WATCHER_HEARTBEAT,
} from './replication.constants';

/** Entries per POST /sync/receive call. */
const PUSH_BATCH_LIMIT = 100;
/** Entries per GET /sync/pull call. */
const PULL_PAGE_LIMIT = 500;
/** Bound on batches/rounds per cycle — a large backlog drains over several
 *  cycles rather than blocking one cycle indefinitely. */
const MAX_BATCHES_PER_CYCLE = 50;

/** In-memory resilience state for one sync direction (Plan 3b). Reset on
 *  process restart → an immediate retry, which is harmless. */
interface DirState {
  consecutiveFailures: number;
  lastErrorClass: ErrorClass | null;
  /** Epoch ms of the earliest next attempt while backing off; 0 = now. */
  nextAttemptAtMs: number;
}

/**
 * Active-side sync orchestrator (spec §6). Every cycle: PUSH local log entries
 * to the peer, then PULL the peer's entries and apply them. Cursors advance
 * only on durable success → at-least-once, crash-safe, idempotent re-apply. In-
 * memory lock (`running`) prevents overlap between the scheduled tick and a
 * manual /sync/now. A passive/unconfigured instance is a strict no-op.
 *
 * Resilience (Plan 3b): each direction backs off exponentially on a retryable
 * transport error and stops (paused-at-cap) on a terminal one; a 413 halves the
 * push batch. Direction health + debounced alerts surface via getSyncStatus.
 */
@Injectable()
export class ReplicationSyncDriverService {
  private readonly logger = new Logger(ReplicationSyncDriverService.name);
  private running = false;

  private readonly outbound: DirState = { consecutiveFailures: 0, lastErrorClass: null, nextAttemptAtMs: 0 };
  private readonly inbound: DirState = { consecutiveFailures: 0, lastErrorClass: null, nextAttemptAtMs: 0 };
  private outboundBatchLimit = PUSH_BATCH_LIMIT;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(ReplicationLog.name) private logModel: Model<ReplicationLogDocument>,
    private settingsService: SettingsService,
    private client: ReplicationSyncClientService,
    private applyService: ReplicationSyncApplyService,
    private eventEmitter: EventEmitter2,
    private deadletter: ReplicationDeadletterService,
    private notifications: NotificationsService,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  private async getSelfInstanceId(): Promise<string> {
    let id = await this.settingsService.get(REPL_INSTANCE_ID);
    if (!id) {
      id = randomUUID();
      await this.settingsService.set(REPL_INSTANCE_ID, id);
    }
    return id;
  }

  private async getCursor(key: string): Promise<number> {
    const raw = await this.settingsService.get(key);
    const n = Number(raw ?? '0');
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /** Locally replication-enabled projectIds (stringified). Same filter as the
   *  server-side servePull opt-in check (spec §6.2). */
  private async getEnabledProjectIds(): Promise<Set<string>> {
    const db = this.connection.db;
    if (!db) return new Set();
    const rows = await db
      .collection('projects')
      .find({ 'replicationConfig.enabled': true }, { projection: { _id: 1 } })
      .toArray();
    return new Set(rows.map((r) => String(r._id)));
  }

  /** Record a transport failure on a direction: classify, count, and schedule
   *  the next attempt (exponential backoff; a terminal error jumps to the cap so
   *  it keeps a slow retry in case the operator fixes the config). */
  private recordFailure(st: DirState, err: unknown): void {
    st.consecutiveFailures += 1;
    st.lastErrorClass = classifyHttpError(err);
    const waitMs =
      st.lastErrorClass === 'terminal'
        ? REPL_BACKOFF_CAP_MS
        : computeBackoffMs(st.consecutiveFailures, REPL_BACKOFF_BASE_MS, REPL_BACKOFF_CAP_MS);
    st.nextAttemptAtMs = Date.now() + waitMs;
  }

  private resetDirection(st: DirState): void {
    st.consecutiveFailures = 0;
    st.lastErrorClass = null;
    st.nextAttemptAtMs = 0;
  }

  async runCycle(trigger: 'scheduled' | 'manual'): Promise<SyncCycleResult> {
    const outboundCursor = await this.getCursor(REPL_CURSOR_OUTBOUND);
    const inboundCursor = await this.getCursor(REPL_CURSOR_INBOUND);
    const noop = (reason: string): SyncCycleResult => ({
      pushed: 0, pulled: 0, applied: 0, skipped: 0,
      outboundCursor, inboundCursor, skippedReason: reason,
    });

    const driver = await this.settingsService.get(REPL_SYNC_DRIVER);
    if (driver !== 'active') return noop(`driver not active (${driver ?? 'unset'})`);
    const peerUrl = await this.settingsService.get(REPL_PEER_URL);
    if (!peerUrl) return noop('no peer URL configured');
    if (this.running) return noop('cycle already running');

    this.running = true;
    try {
      // A manual /sync/now bypasses the backoff window (operator asked explicitly).
      const nowMs = Date.now();
      const bypass = trigger === 'manual';
      const push = bypass || nowMs >= this.outbound.nextAttemptAtMs
        ? await this.pushPhase()
        : { pushed: 0, cursor: outboundCursor };
      const pull = bypass || nowMs >= this.inbound.nextAttemptAtMs
        ? await this.pullPhase()
        : { pulled: 0, applied: 0, skipped: 0, cursor: inboundCursor };

      await this.settingsService.set(REPL_LAST_SYNC_CYCLE, new Date().toISOString());
      await this.evaluateAlerts();
      this.eventEmitter.emit(REPLICATION_STATUS_CHANGED);
      if (push.pushed || pull.applied || pull.skipped) {
        this.logger.log(
          `Sync cycle (${trigger}): pushed ${push.pushed}, pulled ${pull.pulled} ` +
            `(${pull.applied} applied, ${pull.skipped} skipped); ` +
            `cursors out=${push.cursor} in=${pull.cursor}`,
        );
      }
      return {
        pushed: push.pushed,
        pulled: pull.pulled,
        applied: pull.applied,
        skipped: pull.skipped,
        outboundCursor: push.cursor,
        inboundCursor: pull.cursor,
      };
    } finally {
      this.running = false;
    }
  }

  /** PUSH: forward locally-originated, opted-in log entries to the peer in seq
   *  order; advance the outbound cursor only over durably-acked entries. */
  private async pushPhase(): Promise<{ pushed: number; cursor: number }> {
    const self = await this.getSelfInstanceId();
    const enabled = await this.getEnabledProjectIds();
    const excluded = await this.deadletter.pendingEventIds('outbound');
    let cursor = await this.getCursor(REPL_CURSOR_OUTBOUND);
    let pushed = 0;
    let errored = false;

    for (let batch = 0; batch < MAX_BATCHES_PER_CYCLE; batch++) {
      const window = await this.logModel
        .find({ seq: { $gt: cursor } })
        .sort({ seq: 1 })
        .limit(this.outboundBatchLimit)
        .lean()
        .exec();
      if (window.length === 0) break;

      const windowMaxSeq = Number(window[window.length - 1].seq);
      // `toPlainDoc` statt Doppel-Cast: die lean-Dokumente sind POJOs (kein
      // Mongoose-Dokument), die flache Kopie enthält also wirklich alle Felder.
      const entries = window.map((d) => toSyncEntry(toPlainDoc(d)));
      const sendSet = selectSendSet(entries, self, enabled, excluded);

      let newCursor: number;
      if (sendSet.length === 0) {
        // Pure-skip window (all peer-origin or not opted-in) — advance without a round-trip.
        newCursor = advanceOutbound(windowMaxSeq, null, 0, cursor);
      } else {
        const maxSentSeq = sendSet[sendSet.length - 1].seq;
        let resp: SyncReceiveResponse;
        try {
          resp = await this.client.pushReceive(self, sendSet);
        } catch (err) {
          // 413 Payload Too Large → shrink the push batch so the next cycle fits.
          const status = httpErrorStatus(err);
          if (status === 413) {
            this.outboundBatchLimit = Math.max(1, Math.floor(this.outboundBatchLimit / 2));
            this.logger.warn(`Push 413 — halving outbound batch limit to ${this.outboundBatchLimit}`);
          }
          this.logger.warn(`Push failed at cursor ${cursor}: ${errorMessage(err)}`);
          this.recordFailure(this.outbound, err);
          errored = true;
          break; // transient — cursor stays, retry after backoff
        }
        const appliedThrough = Number(resp.appliedThrough);
        if (!Number.isFinite(appliedThrough)) {
          // Malformed peer ack — treat as transient, leave the cursor so we
          // never advance on a NaN (which would otherwise persist as "NaN").
          this.logger.warn(`Push got non-numeric appliedThrough at cursor ${cursor} — skipping advance`);
          this.recordFailure(this.outbound, new Error('non-numeric appliedThrough'));
          errored = true;
          break;
        }
        pushed += sendSet.length;

        // Contiguity resolution (spec §8.2.4): if the receiver stopped short,
        // the first sent entry with seq > appliedThrough whose outcome is
        // transient is the blocker. Count it; once it reaches MAX it is
        // deadlettered → next cycle `excluded` drops it from the send-set →
        // appliedThrough passes it → the cursor advances past it.
        if (appliedThrough < maxSentSeq) {
          const blocker = this.findBlocker(sendSet, resp.results, appliedThrough);
          if (blocker) {
            await this.deadletter.recordFailure('outbound', blocker.entry, blocker.reason);
          } else {
            // Shortfall with no attributable transient result — only reachable
            // against a version-skewed/malformed peer (results missing `outcome`).
            // No deadletter fires, so make the otherwise-invisible retry loop
            // visible instead of silently sticking this direction forever.
            this.logger.warn(
              `Push shortfall at cursor ${cursor} (appliedThrough=${appliedThrough} < maxSentSeq=${maxSentSeq}) with no attributable transient result — peer may be version-skewed; retrying without deadletter.`,
            );
          }
        } else {
          // Everything sent was handled — clear stale retry records below the ack.
          await this.deadletter.clearRetriesUpTo('outbound', appliedThrough);
        }

        newCursor = advanceOutbound(windowMaxSeq, maxSentSeq, appliedThrough, cursor);
      }

      if (newCursor <= cursor) break; // no progress (poison frontier) — stop
      cursor = newCursor;
      await this.settingsService.set(REPL_CURSOR_OUTBOUND, String(cursor));
      if (window.length < this.outboundBatchLimit) break; // window not full → drained
    }

    if (!errored) {
      // Transport healthy this phase — clear backoff + restore the full batch.
      this.resetDirection(this.outbound);
      this.outboundBatchLimit = PUSH_BATCH_LIMIT;
    }
    return { pushed, cursor };
  }

  /** The first sent entry the receiver did NOT handle: lowest seq > appliedThrough
   *  whose per-entry outcome is transient. Returns the entry + a reason, or null
   *  if the shortfall isn't attributable to a specific transient result. */
  private findBlocker(
    sendSet: SyncLogEntry[],
    results: SyncReceiveResponse['results'],
    appliedThrough: number,
  ): { entry: SyncLogEntry; reason: string } | null {
    const bySeq = new Map(sendSet.map((e) => [e.seq, e]));
    const failed = results
      .filter((r) => r.seq > appliedThrough && r.outcome === 'error_transient')
      .sort((a, b) => a.seq - b.seq);
    for (const r of failed) {
      const entry = bySeq.get(r.seq);
      if (entry) return { entry, reason: r.reason ?? 'receiver apply error' };
    }
    return null;
  }

  /** PULL: fetch the peer's changes and apply them locally (origin-tagged by
   *  applyEntry), advancing the inbound cursor only over durably-applied pages. */
  private async pullPhase(): Promise<{
    pulled: number;
    applied: number;
    skipped: number;
    cursor: number;
  }> {
    let cursor = await this.getCursor(REPL_CURSOR_INBOUND);
    let pulled = 0;
    let applied = 0;
    let skipped = 0;
    let errored = false;

    for (let round = 0; round < MAX_BATCHES_PER_CYCLE; round++) {
      let entries: SyncLogEntry[];
      let nextSince: number;
      let hasMore: boolean;
      try {
        const resp = await this.client.pullFrom(cursor, PULL_PAGE_LIMIT);
        entries = Array.isArray(resp.entries) ? resp.entries : [];
        nextSince = Number(resp.nextSince);
        hasMore = !!resp.hasMore;
      } catch (err) {
        this.logger.warn(`Pull failed at since ${cursor}: ${errorMessage(err)}`);
        this.recordFailure(this.inbound, err);
        errored = true;
        break; // transient — cursor stays, retry after backoff
      }
      if (!Number.isFinite(nextSince)) {
        // Malformed peer response — treat as transient, leave the inbound cursor.
        this.logger.warn(`Pull got non-numeric nextSince at since ${cursor} — skipping advance`);
        this.recordFailure(this.inbound, new Error('non-numeric nextSince'));
        errored = true;
        break;
      }
      pulled += entries.length;

      const results: InboundResult[] = [];
      for (const entry of entries) {
        const r = await this.applyService.applyEntry(entry);
        if (r.applied) applied++;
        else skipped++;

        let handled = isTerminalOutcome(r.outcome);
        if (r.outcome === 'error_transient') {
          // Count the failure; deadletter (and treat as handled → advance past)
          // once it has failed MAX_APPLY_ATTEMPTS cycles. Otherwise leave it
          // unhandled so the inbound cursor blocks and the next cycle retries.
          const { deadlettered } = await this.deadletter.recordFailure(
            'inbound', entry, r.reason ?? 'apply error',
          );
          handled = deadlettered;
        } else if (r.applied) {
          // Succeeded — drop any stale retry record for this entry.
          await this.deadletter.clearRetry('inbound', entry.eventId);
        }
        results.push({ seq: entry.seq, handled });
      }

      const newCursor = advanceInbound(results, nextSince, cursor);
      if (newCursor <= cursor) break; // no progress (poison inbound) — stop
      cursor = newCursor;
      await this.settingsService.set(REPL_CURSOR_INBOUND, String(cursor));
      if (!hasMore) break;
    }

    if (!errored) this.resetDirection(this.inbound); // transport healthy → clear backoff
    return { pulled, applied, skipped, cursor };
  }

  /** After a cycle: derive each direction's health and fire debounced alerts
   *  (one on becoming unhealthy, one on recovery), persisting the notified flag
   *  analogous to the monitoring module. Only reached when the driver is active. */
  private async evaluateAlerts(): Promise<void> {
    await Promise.all([
      this.alertDirection('Push (ausgehend)', this.outbound, REPL_OUTBOUND_NOTIFIED_STATE),
      this.alertDirection('Pull (eingehend)', this.inbound, REPL_INBOUND_NOTIFIED_STATE),
    ]);
  }

  private async alertDirection(label: string, st: DirState, notifiedKey: string): Promise<void> {
    const state = deriveDirectionState(true, st.consecutiveFailures, st.lastErrorClass);
    const prevAlerted = (await this.settingsService.get(notifiedKey)) === 'alerted';
    const { action, alerted } = directionAlert(prevAlerted, state, st.consecutiveFailures);
    if (action === 'none') return;

    if (alerted !== prevAlerted) {
      await this.settingsService.set(notifiedKey, alerted ? 'alerted' : '');
    }
    try {
      if (action === 'alert') {
        const nextAt = st.nextAttemptAtMs ? new Date(st.nextAttemptAtMs).toISOString() : 'sofort';
        await this.notifications.create(
          `Replikation: ${label} ${state === 'error' ? 'gestört (Admin-Aktion nötig)' : 'anhaltend fehlerhaft'}`,
          `Die Richtung "${label}" ist seit ${st.consecutiveFailures} Zyklen fehlerhaft (${st.lastErrorClass ?? 'unbekannt'}). Nächster Versuch: ${nextAt}.`,
          '/settings',
          'replication_sync',
        );
      } else {
        await this.notifications.create(
          `Replikation: ${label} wieder gesund`,
          `Die Richtung "${label}" synchronisiert wieder normal.`,
          '/settings',
          'replication_sync',
        );
      }
    } catch (err) {
      this.logger.warn(`Replication alert (${label}) failed: ${errorMessage(err)}`);
    }
  }

  private directionHealth(active: boolean, st: DirState): DirectionHealth {
    return {
      state: deriveDirectionState(active, st.consecutiveFailures, st.lastErrorClass),
      consecutiveFailures: st.consecutiveFailures,
      lastErrorClass: st.lastErrorClass,
      nextAttemptAt: st.nextAttemptAtMs ? new Date(st.nextAttemptAtMs).toISOString() : null,
    };
  }

  /** Cursor/lag + resilience snapshot for the status endpoint + UI (Plan 5). */
  async getSyncStatus(): Promise<SyncStatus> {
    const [driver, outboundCursor, inboundCursor, lastCycleAt, deadletterCount, heartbeat] = await Promise.all([
      this.settingsService.get(REPL_SYNC_DRIVER),
      this.getCursor(REPL_CURSOR_OUTBOUND),
      this.getCursor(REPL_CURSOR_INBOUND),
      this.settingsService.get(REPL_LAST_SYNC_CYCLE),
      this.deadletter.count(),
      this.settingsService.get(REPL_WATCHER_HEARTBEAT),
    ]);
    const active = driver === 'active';
    const top = await this.logModel.findOne().sort({ seq: -1 }).select('seq').lean().exec();
    const localMaxSeq = top ? Number(top.seq) : 0;
    return {
      driver: driver ?? 'unset',
      outboundCursor,
      inboundCursor,
      localMaxSeq,
      outboundLag: Math.max(0, localMaxSeq - outboundCursor),
      lastCycleAt: lastCycleAt ?? null,
      running: this.running,
      deadletterCount,
      outbound: this.directionHealth(active, this.outbound),
      inbound: this.directionHealth(active, this.inbound),
      outboundBatchLimit: this.outboundBatchLimit,
      lastHeartbeatAt: heartbeat ?? null,
    };
  }
}
