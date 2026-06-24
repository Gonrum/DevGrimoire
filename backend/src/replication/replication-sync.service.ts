import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { SettingsService } from '../settings/settings.service';
import { ReplicationLog, ReplicationLogDocument } from './schemas/replication-log.schema';
import { ReplicationSyncApplyService } from './replication-sync-apply.service';
import { toSyncEntry, pullPage } from './replication-sync.helpers';
import { SyncReceiveRequest, SyncReceiveResponse, SyncPullResponse, SyncEntryResult } from './replication-sync.types';
import { REPL_INSTANCE_ID } from './replication.constants';

/** Hard cap on a pull page (count). Byte-capping is the sender's concern. */
const PULL_PAGE_LIMIT = 500;

@Injectable()
export class ReplicationSyncService {
  private readonly logger = new Logger(ReplicationSyncService.name);

  constructor(
    @InjectModel(ReplicationLog.name) private logModel: Model<ReplicationLogDocument>,
    private settingsService: SettingsService,
    private applyService: ReplicationSyncApplyService,
  ) {}

  private async getSelfInstanceId(): Promise<string> {
    let id = await this.settingsService.get(REPL_INSTANCE_ID);
    if (!id) {
      id = randomUUID();
      await this.settingsService.set(REPL_INSTANCE_ID, id);
    }
    return id;
  }

  /**
   * Apply an inbound push batch in seq order. `appliedThrough` = the highest
   * seq that was contiguously HANDLED (applied OR deliberately skipped via
   * LWW/opt-in — both are terminal "done" outcomes). A hard apply error
   * (result with a non-LWW/non-opt-in reason AND applied=false caused by a
   * throw) stops the contiguous run so the sender retries from there (Plan 3
   * turns a persistently-failing entry into a deadletter; for now the run
   * simply stops at it).
   */
  async receiveBatch(req: SyncReceiveRequest): Promise<SyncReceiveResponse> {
    const entries = [...(req.entries ?? [])].sort((a, b) => a.seq - b.seq);
    const results: SyncEntryResult[] = [];
    let appliedThrough = 0;
    let contiguous = true;

    for (const entry of entries) {
      const result = await this.applyService.applyEntry(entry);
      results.push(result);
      // "Handled" = applied, or skipped for a terminal reason (LWW/opt-in/echo/
      // not-replicated/invalid id). Only a genuine apply error (db/throw) is
      // non-terminal and breaks the contiguous ack.
      const terminal = result.applied || this.isTerminalSkip(result.reason);
      if (contiguous && terminal) {
        appliedThrough = entry.seq;
      } else if (!terminal) {
        contiguous = false;
      }
    }
    return { appliedThrough, results };
  }

  /** Skips that are final (the sender should advance past them), vs transient
   *  apply errors that should stop the contiguous ack. */
  private isTerminalSkip(reason?: string): boolean {
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

  /**
   * Serve a page of the LOCAL log to a pulling peer. Returns only
   * locally-originated entries (origin === self — the 2-instance echo filter);
   * `nextSince` is the max seq scanned (incl. filtered) so the caller advances
   * past skips. Reads `since+1 .. ` ordered by seq, capped at PULL_PAGE_LIMIT.
   */
  async servePull(since: number, limit: number): Promise<SyncPullResponse> {
    const cap = Math.min(limit > 0 ? limit : PULL_PAGE_LIMIT, PULL_PAGE_LIMIT);
    const self = await this.getSelfInstanceId();
    const docs = await this.logModel
      .find({ seq: { $gt: since } })
      .sort({ seq: 1 })
      .limit(cap)
      .lean()
      .exec();
    const entries = docs.map((d) => toSyncEntry(d as unknown as Record<string, unknown>));
    const { page, nextSince, hasMore } = pullPage(entries, self, cap);
    return { entries: page, nextSince: nextSince || since, hasMore };
  }
}
