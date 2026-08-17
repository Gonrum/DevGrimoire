import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WorkflowQueueService } from './workflow-queue.service';
import { NodeJob } from './types';
import { errorMessage } from '../workflow-narrow';

export type JobRunner = (job: NodeJob) => Promise<void>;

const POLL_TIMEOUT_MS = 1000;

@Injectable()
export class WorkflowWorkerPool implements OnModuleDestroy {
  private readonly logger = new Logger(WorkflowWorkerPool.name);
  private runner: JobRunner | null = null;
  private stopped = false;
  private workers: Promise<void>[] = [];

  constructor(private readonly queue: WorkflowQueueService) {}

  setRunner(runner: JobRunner): void {
    this.runner = runner;
  }

  start(concurrency: number): void {
    if (this.workers.length > 0) return;
    this.stopped = false;
    const n = Math.max(1, concurrency);
    this.logger.log(`Starting ${n} workflow worker(s)`);
    for (let i = 0; i < n; i++) this.workers.push(this.loop(i));
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.workers);
    this.workers = [];
  }

  private async loop(idx: number): Promise<void> {
    while (!this.stopped) {
      if (!this.runner) {
        await this.queue.wait(POLL_TIMEOUT_MS);
        continue;
      }
      const head = this.queue.peek();
      if (!head) {
        await this.queue.wait(POLL_TIMEOUT_MS);
        continue;
      }
      if (!this.queue.acquireLock(head.definitionId)) {
        await this.queue.wait(POLL_TIMEOUT_MS);
        continue;
      }
      const job = this.queue.take(head.seq);
      if (!job) {
        // raced with another worker; release and retry
        this.queue.releaseLock(head.definitionId);
        continue;
      }
      try {
        await this.runner(job);
      } catch (err: unknown) {
        this.logger.error(
          `Worker ${idx} runner threw (run=${job.runId}, node=${job.nodeId}): ${errorMessage(err)}`,
        );
      } finally {
        this.queue.releaseLock(job.definitionId);
      }
    }
  }
}
