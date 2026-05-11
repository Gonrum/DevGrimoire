import { Injectable, Logger } from '@nestjs/common';
import { NodeJob } from './types';

interface InternalJob extends NodeJob {
  /** monotonic enqueue sequence for stable FIFO */
  seq: number;
  /** earliest time this job may be dispatched (for retry backoff) */
  notBefore: number;
}

@Injectable()
export class WorkflowQueueService {
  private readonly logger = new Logger(WorkflowQueueService.name);
  private readonly jobs: InternalJob[] = [];
  private readonly definitionLocks = new Set<string>();
  private seqCounter = 0;
  /** notified when a new job is enqueued or a lock is released */
  private waiters: Array<() => void> = [];

  enqueue(job: NodeJob, delayMs = 0): void {
    const internal: InternalJob = {
      ...job,
      seq: ++this.seqCounter,
      notBefore: Date.now() + delayMs,
    };
    this.jobs.push(internal);
    this.logger.debug(
      `Enqueued ${job.nodeType}#${job.nodeId} (run=${job.runId}, attempt=${job.attempt}, delay=${delayMs}ms, queueSize=${this.jobs.length})`,
    );
    this.signal();
  }

  /** Remove all pending jobs for a run (used on cancel/retry). */
  removeRun(runId: string): number {
    const before = this.jobs.length;
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      if (this.jobs[i].runId === runId) this.jobs.splice(i, 1);
    }
    return before - this.jobs.length;
  }

  /**
   * Pick the next dispatchable job. Returns null if queue empty or all
   * head-of-line jobs are locked / delayed. Does NOT acquire the definition
   * lock — caller does that via `acquireLock`.
   */
  peek(): InternalJob | null {
    const now = Date.now();
    // sort by seq (FIFO); avoid full sort if already ordered by tracking inserts
    this.jobs.sort((a, b) => a.seq - b.seq);
    for (const job of this.jobs) {
      if (job.notBefore > now) continue;
      if (this.definitionLocks.has(job.definitionId)) continue;
      return job;
    }
    return null;
  }

  take(seq: number): NodeJob | null {
    const idx = this.jobs.findIndex((j) => j.seq === seq);
    if (idx === -1) return null;
    const [removed] = this.jobs.splice(idx, 1);
    return removed;
  }

  acquireLock(definitionId: string): boolean {
    if (this.definitionLocks.has(definitionId)) return false;
    this.definitionLocks.add(definitionId);
    return true;
  }

  releaseLock(definitionId: string): void {
    this.definitionLocks.delete(definitionId);
    this.signal();
  }

  size(): number {
    return this.jobs.length;
  }

  lockedDefinitions(): string[] {
    return [...this.definitionLocks];
  }

  /** Resolves on the next signal (new job, released lock) or after `timeoutMs`. */
  wait(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== resolver);
        resolve();
      }, timeoutMs);
      const resolver = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(resolver);
    });
  }

  private signal(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) w();
  }
}
