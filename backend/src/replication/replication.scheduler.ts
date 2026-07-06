import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import { Cron, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ReplicationPushService } from './replication-push.service';
import { ReplicationFullSyncService } from './replication-full-sync.service';
import { ReplicationPullService } from './replication-pull.service';
import { SettingsService } from '../settings/settings.service';
import { ReplicationSyncDriverService } from './replication-sync-driver.service';
import {
  REPL_ROLE,
  REPL_FULL_SYNC_CRON,
  REPL_PULL_CRON,
  PUSHING_ROLES,
  ReplicationRole,
  REPL_SYNC_INTERVAL_SEC,
} from './replication.constants';

const FULL_SYNC_JOB = 'replication.fullSync';
const PULL_JOB = 'replication.pull';
const DEFAULT_FULL_SYNC_CRON = '0 3 * * *';
const DEFAULT_PULL_CRON = '0 * * * *';
const SYNC_DRIVER_JOB = 'replication.syncDriver';
const DEFAULT_SYNC_INTERVAL_SEC = 20;

@Injectable()
export class ReplicationScheduler implements OnModuleInit {
  private readonly logger = new Logger(ReplicationScheduler.name);

  constructor(
    private pushService: ReplicationPushService,
    private fullSyncService: ReplicationFullSyncService,
    private pullService: ReplicationPullService,
    private settingsService: SettingsService,
    private scheduler: SchedulerRegistry,
    private syncDriver: ReplicationSyncDriverService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Bootstrap dynamic cron jobs from settings so they pick up persisted
    // user changes across restarts. The push-queue poller stays static (it's
    // an internal heartbeat, not user-configurable).
    const fullSyncCron = (await this.settingsService.get(REPL_FULL_SYNC_CRON)) || DEFAULT_FULL_SYNC_CRON;
    const pullCron = (await this.settingsService.get(REPL_PULL_CRON)) || DEFAULT_PULL_CRON;
    this.registerCronJob(FULL_SYNC_JOB, fullSyncCron, () => this.runScheduledFullSync());
    this.registerCronJob(PULL_JOB, pullCron, () => this.runScheduledPull());

    const rawInterval = Number(await this.settingsService.get(REPL_SYNC_INTERVAL_SEC));
    const intervalSec =
      Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : DEFAULT_SYNC_INTERVAL_SEC;
    this.registerSyncDriverInterval(intervalSec);
  }

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

  /** Re-register the FullSync cron job with a new schedule. Called by the
   *  controller when fullSyncCron is changed via PUT /config. Throws
   *  BadRequestException on invalid expressions so the controller can 400. */
  rescheduleFullSync(cron: string): void {
    this.registerCronJob(FULL_SYNC_JOB, cron, () => this.runScheduledFullSync());
    this.logger.log(`Full-sync cron rescheduled to "${cron}"`);
  }

  /** Re-register the Pull cron job with a new schedule. */
  reschedulePull(cron: string): void {
    this.registerCronJob(PULL_JOB, cron, () => this.runScheduledPull());
    this.logger.log(`Pull cron rescheduled to "${cron}"`);
  }

  /** Validate + (re)register a cron job at the given expression. Idempotent:
   *  removes any existing job with the same name first. */
  private registerCronJob(name: string, cronExpr: string, onTick: () => void | Promise<void>): void {
    let job: CronJob;
    try {
      // The CronJob constructor throws synchronously on bad expressions.
      job = new CronJob(cronExpr, onTick);
    } catch (err) {
      throw new BadRequestException(
        `Invalid cron expression "${cronExpr}": ${(err as Error).message}`,
      );
    }
    if (this.scheduler.doesExist('cron', name)) {
      this.scheduler.deleteCronJob(name);
    }
    this.scheduler.addCronJob(name, job);
    job.start();
  }

  private async runScheduledFullSync(): Promise<void> {
    const role = (await this.settingsService.get(REPL_ROLE)) as ReplicationRole | null;
    if (!role || !PUSHING_ROLES.has(role)) return;

    this.logger.log('Starting scheduled full sync...');
    try {
      const result = await this.fullSyncService.runFullSync();
      this.logger.log(
        `Scheduled sync done: ${result.projects} projects, ${result.entities} entities, ${result.skipped} LWW-skipped, ${result.errors} errors`,
      );
    } catch (err) {
      this.logger.error(`Scheduled full sync failed: ${(err as Error).message}`);
    }
  }

  private async runScheduledPull(): Promise<void> {
    const role = (await this.settingsService.get(REPL_ROLE)) as ReplicationRole | null;
    if (role !== 'peer') return;

    try {
      const result = await this.pullService.runPull();
      if (result.error) {
        this.logger.warn(`Scheduled pull error: ${result.error}`);
      } else if (result.applied > 0 || result.skipped > 0) {
        this.logger.log(
          `Scheduled pull: ${result.pulled} pulled, ${result.applied} applied, ${result.skipped} skipped over ${result.rounds} round(s)`,
        );
      }
    } catch (err) {
      this.logger.error(`Scheduled pull failed: ${(err as Error).message}`);
    }
  }

  /** (Re)register the sync-driver tick at the given interval. The driver itself
   *  gates on syncDriver==='active' + a configured peer, so a passive instance's
   *  tick is a cheap no-op. Min 5s floor guards against a misconfigured 0. */
  registerSyncDriverInterval(seconds: number): void {
    const ms = Math.max(5, seconds) * 1000;
    if (this.scheduler.doesExist('interval', SYNC_DRIVER_JOB)) {
      this.scheduler.deleteInterval(SYNC_DRIVER_JOB);
    }
    const handle = setInterval(() => void this.runSyncCycle(), ms);
    this.scheduler.addInterval(SYNC_DRIVER_JOB, handle);
    this.logger.log(`Sync driver tick registered at ${Math.max(5, seconds)}s`);
  }

  private async runSyncCycle(): Promise<void> {
    try {
      await this.syncDriver.runCycle('scheduled');
    } catch (err) {
      this.logger.error(`Sync cycle failed: ${(err as Error).message}`);
    }
  }
}
