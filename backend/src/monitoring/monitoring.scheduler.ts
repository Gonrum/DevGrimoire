import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MonitoringService } from './monitoring.service';
import { errorMessage } from '../common/narrow';

@Injectable()
export class MonitoringScheduler {
  private readonly logger = new Logger(MonitoringScheduler.name);

  constructor(private readonly monitoringService: MonitoringService) {}

  // Tick every minute — checks with sub-minute intervals are not supported
  // (and are guarded by the DTO floor of 60s).
  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    try {
      const count = await this.monitoringService.processDueChecks();
      if (count > 0) {
        this.logger.log(`Executed ${count} healthcheck(s)`);
      }
    } catch (err: unknown) {
      this.logger.error(`Monitoring scheduler tick failed: ${errorMessage(err)}`);
    }
  }
}
