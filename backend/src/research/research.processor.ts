import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job } from 'bullmq';
import { errorMessage } from '../common/narrow';
import { RESEARCH_DELAY_MS, RESEARCH_QUEUE, type ResearchJobData } from './research-queue';
import { ResearchRunnerService } from './research-runner.service';

@Processor(RESEARCH_QUEUE, { concurrency: 4, autorun: false })
export class ResearchProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(ResearchProcessor.name);

  constructor(private readonly runner: ResearchRunnerService) { super(); }

  /** Nicht im stdio-MCP-Prozess: sonst arbeiten zwei Prozesse dieselbe Queue ab. */
  onApplicationBootstrap(): void {
    if (process.env.MCP_STDIO === 'true') return;
    this.worker.run().catch((err: unknown) => this.logger.error(`Recherche-Worker beendet: ${errorMessage(err)}`));
  }

  async process(job: Job<ResearchJobData>, token?: string): Promise<void> {
    const decision = await this.runner.mayStart(job.data.id);
    if (decision === 'drop') return;
    if (decision === 'wait') {
      await job.moveToDelayed(Date.now() + RESEARCH_DELAY_MS, token);
      throw new DelayedError();
    }
    await this.runner.run(job.data.id);
    // Während des Laufs fortgesetzt (z. B. Pause → Fortsetzen): dieselbe jobId
    // war noch aktiv, ein neues `add` wurde verschluckt — also hier weiter.
    if (await this.runner.isQueued(job.data.id)) {
      await job.moveToDelayed(Date.now() + RESEARCH_DELAY_MS, token);
      throw new DelayedError();
    }
  }
}
