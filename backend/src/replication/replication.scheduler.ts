import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ReplicationPushService } from './replication-push.service';
import { ReplicationFullSyncService } from './replication-full-sync.service';
import { ReplicationPullService } from './replication-pull.service';
import { SettingsService } from '../settings/settings.service';
import {
  REPL_ROLE,
  PUSHING_ROLES,
  ReplicationRole,
} from './replication.constants';

@Injectable()
export class ReplicationScheduler {
  private readonly logger = new Logger(ReplicationScheduler.name);

  constructor(
    private pushService: ReplicationPushService,
    private fullSyncService: ReplicationFullSyncService,
    private pullService: ReplicationPullService,
    private settingsService: SettingsService,
  ) {}

  /** Process replication queue every 30 seconds (master + peer push backlog). */
  @Cron('*/30 * * * * *')
  async processQueue(): Promise<void> {
    const role = (await this.settingsService.get(REPL_ROLE)) as ReplicationRole | null;
    if (!role || !PUSHING_ROLES.has(role)) return;

    try {
      const sent = await this.pushService.processQueue();
      if (sent > 0) {
        this.logger.debug(`Processed ${sent} queued replication items`);
      }
    } catch (err) {
      this.logger.error(`Queue processing failed: ${(err as Error).message}`);
    }
  }

  /** Nightly full sync at 3 AM (master + peer). */
  @Cron('0 3 * * *')
  async nightlyFullSync(): Promise<void> {
    const role = (await this.settingsService.get(REPL_ROLE)) as ReplicationRole | null;
    if (!role || !PUSHING_ROLES.has(role)) return;

    this.logger.log('Starting nightly full sync...');
    try {
      const result = await this.fullSyncService.runFullSync();
      this.logger.log(
        `Nightly sync done: ${result.projects} projects, ${result.entities} entities, ${result.errors} errors`,
      );
    } catch (err) {
      this.logger.error(`Nightly full sync failed: ${(err as Error).message}`);
    }
  }

  /**
   * Hourly pull from the peer (only meaningful for `peer` role). Default cron
   * is fixed at top-of-the-hour for simplicity; future iteration can register
   * the schedule dynamically from REPL_PULL_CRON via SchedulerRegistry.
   */
  @Cron('0 * * * *')
  async hourlyPull(): Promise<void> {
    const role = (await this.settingsService.get(REPL_ROLE)) as ReplicationRole | null;
    if (role !== 'peer') return;

    try {
      const result = await this.pullService.runPull();
      if (result.error) {
        this.logger.warn(`Hourly pull error: ${result.error}`);
      } else if (result.applied > 0 || result.skipped > 0) {
        this.logger.log(
          `Hourly pull: ${result.pulled} pulled, ${result.applied} applied, ${result.skipped} skipped over ${result.rounds} round(s)`,
        );
      }
    } catch (err) {
      this.logger.error(`Hourly pull failed: ${(err as Error).message}`);
    }
  }
}
