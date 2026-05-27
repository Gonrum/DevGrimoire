import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { QuestionsService } from './questions.service';

/**
 * Cron-driven walker for the T-393 escalation chain. Once a minute it asks
 * QuestionsService to advance every pending agent_to_user question whose wait
 * window has lapsed: re-resolve targets, reset the deadline, fire fresh
 * notifications. Questions without (or beyond) an escalation chain flip to
 * `expired` here instead of relying on a per-call waitForAnswer poll.
 */
@Injectable()
export class QuestionsScheduler {
  private readonly logger = new Logger(QuestionsScheduler.name);
  private running = false;

  constructor(private readonly questionsService: QuestionsService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const summary = await this.questionsService.escalateDueQuestions();
      if (summary.checked > 0) {
        this.logger.log(
          `Escalation tick: checked=${summary.checked} escalated=${summary.escalated} expired=${summary.expired}`,
        );
      }
    } catch (err) {
      this.logger.warn(`Escalation tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
