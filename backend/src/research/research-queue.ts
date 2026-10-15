import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

export const RESEARCH_QUEUE = 'research';
export const RESEARCH_DELAY_MS = 10_000;
export const jobIdFor = (id: string): string => `research-${id}`;

export interface ResearchJobData { id: string }

/** Zustände, aus denen ein Job ohne Eingriff in einen laufenden Lauf entfernt werden darf. */
const REMOVABLE = new Set(['waiting', 'delayed', 'prioritized', 'waiting-children']);
const FINISHED = new Set(['completed', 'failed']);

@Injectable()
export class ResearchQueueService {
  constructor(@InjectQueue(RESEARCH_QUEUE) private readonly queue: Queue<ResearchJobData>) {}

  async enqueue(id: string): Promise<void> {
    const jobId = jobIdFor(id);
    // Ein abgeschlossener Job mit derselben jobId (removeOnFail behält 100)
    // würde `add` stillschweigend verschlucken.
    const existing = await this.queue.getJob(jobId);
    if (existing && FINISHED.has(await existing.getState())) await existing.remove();
    await this.queue.add('run', { id }, { jobId, attempts: 1, removeOnComplete: true, removeOnFail: 100 });
  }

  /** Wartenden/verzögerten Job entfernen; einen laufenden nicht (der endet über sein Flag). */
  async remove(id: string): Promise<void> {
    const job = await this.queue.getJob(jobIdFor(id));
    if (!job) return;
    const state = await job.getState();
    if (REMOVABLE.has(state) || FINISHED.has(state)) await job.remove();
  }
}
