import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job } from 'bullmq';
import { errorMessage } from '../common/narrow';
import { RESEARCH_DELAY_MS, RESEARCH_QUEUE, ResearchQueueService, type ResearchJobData } from './research-queue';
import { ResearchRunStore } from './research-run-store';
import { ResearchRunnerService, type MayStart } from './research-runner.service';

@Processor(RESEARCH_QUEUE, { concurrency: 4, autorun: false })
export class ResearchProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(ResearchProcessor.name);

  constructor(
    private readonly runner: ResearchRunnerService,
    private readonly store: ResearchRunStore,
    private readonly queue: ResearchQueueService,
  ) { super(); }

  /** Nicht im stdio-MCP-Prozess: sonst arbeiten zwei Prozesse dieselbe Queue ab. */
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.MCP_STDIO === 'true') return;
    this.worker.run().catch((err: unknown) => this.logger.error(`Recherche-Worker beendet: ${errorMessage(err)}`));
    await this.requeueWaiting();
  }

  /**
   * Wartende Dokumente ohne lebenden Job (Redis-Verlust, gescheiterter Job)
   * blockierten sonst alle späteren desselben Besitzers. Die jobId dedupliziert.
   */
  async requeueWaiting(): Promise<number> {
    let ids: string[];
    try {
      ids = await this.store.listQueuedIds();
    } catch (err) {
      this.logger.error(`Wartende Recherchen nicht lesbar: ${errorMessage(err)}`);
      return 0;
    }
    let n = 0;
    for (const id of ids) {
      try {
        await this.queue.enqueue(id);
        n += 1;
      } catch (err) {
        this.logger.warn(`Recherche ${id} nicht neu eingereiht: ${errorMessage(err)}`);
      }
    }
    return n;
  }

  private async later(job: Job<ResearchJobData>, token?: string): Promise<never> {
    await job.moveToDelayed(Date.now() + RESEARCH_DELAY_MS, token);
    throw new DelayedError();
  }

  async process(job: Job<ResearchJobData>, token?: string): Promise<void> {
    let decision: MayStart;
    try {
      decision = await this.runner.mayStart(job.data.id);
    } catch (err) {
      // Nie ein harter Job-Fehler (attempts 1): das Dokument bliebe queued ohne Job.
      this.logger.warn(`Recherche ${job.data.id}: Startprüfung gescheitert, später erneut: ${errorMessage(err)}`);
      decision = 'wait';
    }
    if (decision === 'drop') return;
    if (decision === 'wait') return this.later(job, token);
    await this.runner.run(job.data.id);
    // Während des Laufs fortgesetzt (z. B. Pause → Fortsetzen): dieselbe jobId
    // war noch aktiv, ein neues `add` wurde verschluckt — also hier weiter.
    // Ist das nicht feststellbar, ebenfalls später erneut: mayStart verwirft dann.
    let again: boolean;
    try {
      again = await this.runner.isQueued(job.data.id);
    } catch {
      again = true;
    }
    if (again) return this.later(job, token);
  }
}
