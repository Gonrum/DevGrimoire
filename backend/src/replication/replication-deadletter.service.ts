import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { NotificationsService } from '../notifications/notifications.service';
import { ReplicationSyncApplyService } from './replication-sync-apply.service';
import {
  ReplicationDeadletter,
  ReplicationDeadletterDocument,
} from './schemas/replication-deadletter.schema';
import { SyncLogEntry } from './replication-sync.types';
import { MAX_APPLY_ATTEMPTS } from './replication.constants';
import { errorMessage } from './replication-narrow.helpers';

type Direction = 'inbound' | 'outbound';

/**
 * Persistent retry/deadletter store. One doc per (direction, eventId). Counts
 * transient apply failures; after MAX_APPLY_ATTEMPTS an entry is promoted to
 * `pending` (final), alerted once, and the driver advances the cursor past it —
 * never a silent drop (spec §5.4, §8.2).
 */
@Injectable()
export class ReplicationDeadletterService {
  private readonly logger = new Logger(ReplicationDeadletterService.name);

  constructor(
    @InjectModel(ReplicationDeadletter.name)
    private model: Model<ReplicationDeadletterDocument>,
    private applyService: ReplicationSyncApplyService,
    private notifications: NotificationsService,
  ) {}

  /**
   * Record one failed apply attempt for an entry. Increments the attempt count
   * (upsert). When attempts reach MAX_APPLY_ATTEMPTS the record is promoted to
   * `pending` and a single notification fires. Returns the current attempt count
   * and whether the entry is now deadlettered (caller advances past it).
   */
  async recordFailure(
    direction: Direction,
    entry: SyncLogEntry,
    reason: string,
  ): Promise<{ attempts: number; deadlettered: boolean }> {
    const now = new Date();
    const doc = await this.model.findOneAndUpdate(
      { direction, eventId: entry.eventId },
      {
        $inc: { attempts: 1 },
        $set: {
          seq: entry.seq,
          collection: entry.collection,
          documentId: entry.documentId,
          projectId: entry.projectId,
          payload: entry,
          reason,
          lastFailedAt: now,
        },
        $setOnInsert: { firstFailedAt: now, status: 'retrying' },
      },
      { upsert: true, new: true },
    );

    // A doc already marked pending/replayed/discarded should not re-alert.
    if (doc.status === 'retrying' && doc.attempts >= MAX_APPLY_ATTEMPTS) {
      doc.status = 'pending';
      await doc.save();
      this.logger.warn(
        `Deadlettered ${direction} entry ${entry.collection}/${entry.documentId} (seq ${entry.seq}) after ${doc.attempts} attempts: ${reason}`,
      );
      await this.notifications
        .create(
          'Replikation: Eintrag im Deadletter',
          `${direction === 'inbound' ? 'Eingehender' : 'Ausgehender'} Eintrag ${entry.collection}/${entry.documentId} konnte nach ${doc.attempts} Versuchen nicht appliziert werden: ${reason}. Der Cursor läuft weiter; der Eintrag liegt im Deadletter (Quelle unverändert).`,
          '/settings',
          'replication_deadletter',
        )
        .catch((err: unknown) => this.logger.warn(`Deadletter notification failed: ${errorMessage(err)}`));
      return { attempts: doc.attempts, deadlettered: true };
    }
    return { attempts: doc.attempts, deadlettered: doc.status === 'pending' };
  }

  /** Drop `retrying` records at or below a seq that has since been handled
   *  (they succeeded before reaching the deadletter threshold). Keeps
   *  `pending`/`replayed`/`discarded` records. */
  async clearRetriesUpTo(direction: Direction, seq: number): Promise<void> {
    await this.model.deleteMany({ direction, status: 'retrying', seq: { $lte: seq } });
  }

  /** Drop the `retrying` record for one entry that just succeeded. */
  async clearRetry(direction: Direction, eventId: string): Promise<void> {
    await this.model.deleteOne({ direction, eventId, status: 'retrying' });
  }

  /** Deadlettered (final) eventIds for a direction — excluded from the send-set
   *  / treated as handled on pull. */
  async pendingEventIds(direction: Direction): Promise<Set<string>> {
    const rows = await this.model
      .find({ direction, status: 'pending' }, { eventId: 1 })
      .lean()
      .exec();
    return new Set(rows.map((r) => r.eventId));
  }

  /** Count of final (pending) deadletters — surfaced in /sync/status. */
  async count(): Promise<number> {
    return this.model.countDocuments({ status: 'pending' });
  }

  async listPending(limit = 100): Promise<ReplicationDeadletterDocument[]> {
    return this.model.find({ status: 'pending' }).sort({ lastFailedAt: -1 }).limit(limit).exec();
  }

  /** Re-apply a deadletter's stored payload via the idempotent apply path. On
   *  success mark it `replayed`; otherwise leave it pending with the new reason. */
  async replay(id: string): Promise<{ ok: boolean; reason?: string }> {
    const doc = await this.model.findById(id).exec();
    if (!doc || doc.status !== 'pending') return { ok: false, reason: 'not a pending deadletter' };
    // `payload` ist im Schema als `SyncLogEntry` typisiert (Mixed zur Laufzeit),
    // der Doppel-Cast war nur nötig, solange dort `Record<string, unknown>` stand.
    // Reine Typ-Änderung: `applyEntry` prüft die Felder ohnehin selbst.
    const result = await this.applyService.applyEntry(doc.payload);
    if (result.applied || result.outcome !== 'error_transient') {
      doc.status = 'replayed';
      await doc.save();
      return { ok: true };
    }
    doc.reason = result.reason ?? doc.reason;
    doc.lastFailedAt = new Date();
    await doc.save();
    return { ok: false, reason: result.reason };
  }

  async discard(id: string): Promise<{ ok: boolean }> {
    const doc = await this.model.findById(id).exec();
    if (!doc || doc.status !== 'pending') return { ok: false };
    doc.status = 'discarded';
    await doc.save();
    return { ok: true };
  }

  /**
   * Prune resolved history (`replayed`/`discarded` older than `resolvedCutoff`)
   * and orphaned `retrying` records (lastFailedAt older than `orphanCutoff` — an
   * entry that succeeded via a non-clearing path or was terminal-skipped, P3a
   * follow-up). `pending` is never touched: it is unresolved and drives count().
   */
  async gc(
    resolvedCutoff: Date,
    orphanCutoff: Date,
  ): Promise<{ orphanedRetrying: number; resolved: number }> {
    const [orphans, resolved] = await Promise.all([
      this.model.deleteMany({ status: 'retrying', lastFailedAt: { $lt: orphanCutoff } }),
      this.model.deleteMany({
        status: { $in: ['replayed', 'discarded'] },
        lastFailedAt: { $lt: resolvedCutoff },
      }),
    ]);
    return {
      orphanedRetrying: orphans.deletedCount ?? 0,
      resolved: resolved.deletedCount ?? 0,
    };
  }
}
