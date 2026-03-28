import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RecurringTasksService } from './recurring-tasks.service';

@Injectable()
export class RecurringTasksScheduler {
  private readonly logger = new Logger(RecurringTasksScheduler.name);

  constructor(private readonly recurringTasksService: RecurringTasksService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron() {
    const count = await this.recurringTasksService.processDueTasks();
    if (count > 0) {
      this.logger.log(`Processed ${count} recurring task(s)`);
    }
  }
}
