import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SettingsService } from '../settings/settings.service';
import { ReplicationLog, ReplicationLogDocument } from './schemas/replication-log.schema';
import { REPL_LOG_RETENTION_DAYS, REPL_SYNC_DRIVER, REPL_CURSOR_OUTBOUND } from './replication.constants';
import { resolveRetentionDays, logGcBound, deadletterGcCutoffs } from './replication-gc.helpers';
import { ReplicationDeadletterService } from './replication-deadletter.service';

export interface GcResult {
  deleted: number;
  retentionDays: number;
  cutoff: string;
  maxSeqInclusive: number;
  guarded: boolean;
  deadletterOrphansDeleted: number;
  deadletterResolvedDeleted: number;
  skippedReason?: string;
}

/**
 * Prunes the replication_log by age (Plan 4). The log-writer runs on every
 * replica-set instance and never deletes, so without this the collection grows
 * without bound (~790K entries on dev). `replication_applied` already self-GCs
 * via its TTL index — only the log needs an explicit pass.
 *
 * Safety: on the active driver, entries above the outbound cursor are
 * un-replicated local writes and are never deleted regardless of age. See
 * logGcBound() for the passive-side age-only contract.
 */
@Injectable()
export class ReplicationGcService {
  private readonly logger = new Logger(ReplicationGcService.name);
  private readonly standalone: boolean;

  constructor(
    @InjectModel(ReplicationLog.name) private logModel: Model<ReplicationLogDocument>,
    private settingsService: SettingsService,
    private deadletter: ReplicationDeadletterService,
  ) {
    this.standalone = process.env.MONGODB_STANDALONE === 'true';
  }

  /** Daily at 04:00. The passive side ages its log out too — the peer has
   *  pulled it by then (operator contract: retention > offline window). */
  @Cron('0 4 * * *')
  async scheduledGc(): Promise<void> {
    try {
      const result = await this.runGc();
      const dl = result.deadletterOrphansDeleted + result.deadletterResolvedDeleted;
      if (result.deleted > 0 || dl > 0) {
        this.logger.log(
          `GC pruned ${result.deleted} replication_log entries older than ` +
            `${result.retentionDays}d (cutoff ${result.cutoff}, maxSeq ${result.maxSeqInclusive}); ` +
            `deadletter: ${result.deadletterOrphansDeleted} orphaned retries, ` +
            `${result.deadletterResolvedDeleted} resolved`,
        );
      }
    } catch (err) {
      this.logger.error(`replication_log GC failed: ${(err as Error).message}`);
    }
  }

  private async getCursor(key: string): Promise<number> {
    const n = Number((await this.settingsService.get(key)) ?? '0');
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /** Run one GC pass. Exposed for the admin endpoint + E2E. In standalone mode
   *  the log writer never ran, so there is nothing to prune. */
  async runGc(): Promise<GcResult> {
    const retentionDays = resolveRetentionDays(await this.settingsService.get(REPL_LOG_RETENTION_DAYS));
    if (this.standalone) {
      return {
        deleted: 0, retentionDays, cutoff: new Date(0).toISOString(),
        maxSeqInclusive: 0, guarded: false,
        deadletterOrphansDeleted: 0, deadletterResolvedDeleted: 0,
        skippedReason: 'standalone (no log writer)',
      };
    }

    const nowMs = Date.now();
    const isActive = (await this.settingsService.get(REPL_SYNC_DRIVER)) === 'active';
    const outboundCursor = await this.getCursor(REPL_CURSOR_OUTBOUND);
    const bound = logGcBound(nowMs, retentionDays, isActive, outboundCursor);

    const res = await this.logModel.deleteMany({
      createdAt: { $lt: new Date(bound.cutoffMs) },
      seq: { $lte: bound.maxSeqInclusive },
    });

    // Same pass prunes deadletter history + orphaned retry records (never pending).
    const dlCutoffs = deadletterGcCutoffs(nowMs, retentionDays);
    const dl = await this.deadletter.gc(
      new Date(dlCutoffs.resolvedCutoffMs),
      new Date(dlCutoffs.orphanCutoffMs),
    );

    return {
      deleted: res.deletedCount ?? 0,
      retentionDays,
      cutoff: new Date(bound.cutoffMs).toISOString(),
      maxSeqInclusive: bound.maxSeqInclusive,
      guarded: isActive,
      deadletterOrphansDeleted: dl.orphanedRetrying,
      deadletterResolvedDeleted: dl.resolved,
    };
  }
}
