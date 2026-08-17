import { Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '../common/narrow';
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
      // Wake snoozed questions first so the same tick can immediately escalate
      // them if their original wait window also lapsed.
      const wakeSummary = await this.questionsService.wakeSnoozedQuestions();
      if (wakeSummary.woken > 0) {
        this.logger.log(`Wake tick: woken=${wakeSummary.woken} of ${wakeSummary.checked} snoozed`);
      }
      const escalationSummary = await this.questionsService.escalateDueQuestions();
      if (escalationSummary.checked > 0) {
        this.logger.log(
          `Escalation tick: checked=${escalationSummary.checked} escalated=${escalationSummary.escalated} expired=${escalationSummary.expired}`,
        );
      }
    } catch (err) {
      this.logger.warn(`Scheduler tick failed: ${errorMessage(err)}`);
    } finally {
      this.running = false;
    }
  }
}
