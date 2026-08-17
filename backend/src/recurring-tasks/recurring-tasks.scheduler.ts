import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RecurringTasksService } from './recurring-tasks.service';
import { errorMessage } from '../common/narrow';

@Injectable()
export class RecurringTasksScheduler {
  private readonly logger = new Logger(RecurringTasksScheduler.name);

  constructor(private readonly recurringTasksService: RecurringTasksService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    // Wie im Monitoring-Scheduler: der Cron-Aufrufer fängt nichts. Ein Fehler
    // aus `processDueTasks` (DB weg, kaputter Zeitplan) war damit eine
    // unbehandelte Rejection — und die beendet unter Node 22 den Prozess.
    try {
      const count = await this.recurringTasksService.processDueTasks();
      if (count > 0) {
        this.logger.log(`Processed ${count} recurring task(s)`);
      }
    } catch (err: unknown) {
      this.logger.error(`Recurring-task scheduler tick failed: ${errorMessage(err)}`);
    }
  }
}
