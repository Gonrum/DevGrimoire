import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ReplicationPushService } from './replication-push.service';
import { ReplicationFullSyncService } from './replication-full-sync.service';
import { SettingsService } from '../settings/settings.service';
import { REPL_ROLE } from './replication.constants';

@Injectable()
export class ReplicationScheduler {
  private readonly logger = new Logger(ReplicationScheduler.name);

  constructor(
    private pushService: ReplicationPushService,
    private fullSyncService: ReplicationFullSyncService,
    private settingsService: SettingsService,
  ) {}

  /** Process replication queue every 30 seconds */
  @Cron('*/30 * * * * *')
  async processQueue(): Promise<void> {
    const role = await this.settingsService.get(REPL_ROLE);
    if (role !== 'master') return;

    try {
      const sent = await this.pushService.processQueue();
      if (sent > 0) {
        this.logger.debug(`Processed ${sent} queued replication items`);
      }
    } catch (err) {
      this.logger.error(`Queue processing failed: ${(err as Error).message}`);
    }
  }

  /** Nightly full sync at 3 AM */
  @Cron('0 3 * * *')
  async nightlyFullSync(): Promise<void> {
    const role = await this.settingsService.get(REPL_ROLE);
    if (role !== 'master') return;

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
}
