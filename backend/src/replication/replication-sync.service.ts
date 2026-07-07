import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { SettingsService } from '../settings/settings.service';
import { ReplicationLog, ReplicationLogDocument } from './schemas/replication-log.schema';
import { ReplicationSyncApplyService } from './replication-sync-apply.service';
import { toSyncEntry, pullPage } from './replication-sync.helpers';
import { isTerminalOutcome } from './replication-sync-cursor.helpers';
import { SyncReceiveRequest, SyncReceiveResponse, SyncPullResponse, SyncEntryResult } from './replication-sync.types';
import { REPL_INSTANCE_ID } from './replication.constants';

/** Hard cap on a pull page (count). Byte-capping is the sender's concern. */
const PULL_PAGE_LIMIT = 500;

@Injectable()
export class ReplicationSyncService {
  private readonly logger = new Logger(ReplicationSyncService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
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
      const terminal = isTerminalOutcome(result.outcome);
      if (contiguous && terminal) {
        appliedThrough = entry.seq;
      } else if (!terminal) {
        contiguous = false;
      }
    }
    return { appliedThrough, results };
  }

  /** Set of locally replication-enabled projectIds (stringified). Spec §6.2:
   *  only opted-in projects may be served — otherwise a peer would receive
   *  documents of projects the user never enabled (confidentiality + bandwidth). */
  private async getEnabledProjectIds(): Promise<Set<string>> {
    const db = this.connection.db;
    if (!db) return new Set();
    const rows = await db
      .collection('projects')
      .find({ 'replicationConfig.enabled': true }, { projection: { _id: 1 } })
      .toArray();
    return new Set(rows.map((r) => String(r._id)));
  }

  /**
   * Serve a page of the LOCAL log to a pulling peer. Returns only
   * locally-originated entries (origin === self — the 2-instance echo filter)
   * AND only entries of opted-in projects (spec §6.2 — projects whose
   * `replicationConfig.enabled` is true); `nextSince` is the max seq scanned
   * (incl. filtered) so the caller advances past skips. Reads `since+1 .. `
   * ordered by seq, capped at PULL_PAGE_LIMIT.
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
    const { page: originPage, nextSince, hasMore } = pullPage(entries, self, cap);
    const enabled = await this.getEnabledProjectIds();
    const page = originPage.filter((e) => e.projectId != null && enabled.has(e.projectId));
    return { entries: page, nextSince: nextSince || since, hasMore };
  }
}
