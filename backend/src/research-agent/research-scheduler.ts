import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Types } from 'mongoose';
import { ResearchTopicService } from './research-topic.service';
import { ResearchRunService } from './research-run.service';
import { ResearchAgentService } from './research-agent.service';
import { ResearchTopicDocument } from './schemas/research-topic.schema';
import { ResearchRunStatus } from './schemas/research-run.schema';

/**
 * Cron-driven poller for the autonomous research agent's schedules (Phase 5,
 * Task 15). Once a minute, fires every active topic whose
 * `schedule.nextRun` has lapsed.
 *
 * Two invariants this scheduler is built around:
 *
 * 1. **`nextRun` advances BEFORE the run executes.** For every due topic,
 *    `topicService.markRun(topicId, ranAt, ...)` is called with the tick's
 *    own `ranAt` up front — strictly before `agentService.run` is ever
 *    invoked (and even before deciding whether to skip it). A crash, a run
 *    that outlives the next tick, or a topic being skipped for having an
 *    already-active run therefore never causes a re-fire on the following
 *    tick — the schedule has already moved on.
 * 2. **Manual and scheduled runs never overlap for the same topic.** Before
 *    starting `agentService.run(topicId, 'scheduled')`, this checks
 *    `runService.listByTopic(topicId)` for an already-`running`/`queued` run
 *    (mirrors `ResearchAgentController.startRun`'s 409 guard) and skips
 *    starting a second one if so — nextRun has already advanced regardless.
 */
@Injectable()
export class ResearchScheduler {
  private readonly logger = new Logger(ResearchScheduler.name);
  private running = false;

  constructor(
    private readonly topicService: ResearchTopicService,
    private readonly runService: ResearchRunService,
    private readonly agentService: ResearchAgentService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    // Background scheduling only makes sense in the long-lived HTTP backend
    // process — the stdio MCP entrypoint is a short-lived per-call process
    // (see mcp-server.ts) and must not also try to fire scheduled runs.
    if (process.env.MCP_STDIO === 'true') return;

    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const due = await this.topicService.findDue(now);
      for (const topic of due) {
        try {
          await this.fireTopic(topic, now);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`Failed to process due research topic ${topic._id}: ${message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async fireTopic(topic: ResearchTopicDocument, ranAt: Date): Promise<void> {
    const topicId = topic._id.toString();

    // Advance nextRun FIRST — see invariant (1) in the class doc comment.
    await this.topicService.markRun(topicId, ranAt, 'running');

    const existingRuns = await this.runService.listByTopic(topicId);
    const activeRun = existingRuns.find(
      (r) => r.status === ResearchRunStatus.RUNNING || r.status === ResearchRunStatus.QUEUED,
    );
    if (activeRun) {
      this.logger.warn(
        `Skipping scheduled research run for topic ${topicId} — run #${activeRun.number} is already active`,
      );
      await this.topicService.markRun(topicId, ranAt, 'skipped');
      return;
    }

    try {
      // `ResearchAgentService.run` never throws for a run-local failure — it
      // records `done`/`error`/`cancelled` on the run itself and resolves
      // normally. Only a failure to load the topic/owner propagates here.
      const run = await this.agentService.run(topicId, 'scheduled');
      await this.topicService.markRun(topicId, ranAt, run.status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Scheduled research run failed for topic ${topicId}: ${message}`);
      await this.topicService.markRun(topicId, ranAt, 'error');
    }
  }
}
