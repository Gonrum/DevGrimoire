import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ResearchRun,
  ResearchRunDocument,
  ResearchRunStatus,
  RunStep,
  RunTokenUsage,
} from './schemas/research-run.schema';

/** One SSE-shaped event fanned out for a single run. `[k: string]: unknown` lets
 * each `type` carry its own payload shape without a discriminated-union per call site. */
export interface RunEvent {
  type: 'run_started' | 'step' | 'artifact' | 'done' | 'error';
  [k: string]: unknown;
}

export interface FinalizeRunPatch {
  status: ResearchRunStatus;
  summary?: string;
  error?: string;
  artifactsCreated?: string[];
  artifactsUpdated?: string[];
  tokenUsage?: RunTokenUsage;
}

/**
 * Tiny in-memory pub/sub keyed by runId, used to stream a single
 * research-agent run's progress (tool calls, artifact writes, completion) to
 * any number of connected SSE clients.
 *
 * Deliberately dependency-free (no Mongoose/Nest imports) so it is
 * unit-testable in isolation from the database — see
 * `scripts/research-run-bus-check.cjs`. `ResearchRunService` holds exactly
 * one instance and delegates to it.
 *
 * Unsubscribing removes the callback from its runId's Set, and once that Set
 * is empty the Map entry itself is deleted — a run with zero current
 * listeners leaves no trace in the bus, so long-lived server processes don't
 * accumulate an ever-growing Map of empty Sets across thousands of
 * historical runs.
 */
export class RunEventBus {
  private readonly subscribers = new Map<string, Set<(event: RunEvent) => void>>();

  subscribe(runId: string, cb: (event: RunEvent) => void): () => void {
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(cb);

    return () => {
      const current = this.subscribers.get(runId);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) {
        this.subscribers.delete(runId);
      }
    };
  }

  publish(runId: string, event: RunEvent): void {
    const set = this.subscribers.get(runId);
    if (!set || set.size === 0) return;
    for (const cb of set) {
      cb(event);
    }
  }

  /** Whether any subscriber is currently listening for this runId's events. */
  hasSubscribers(runId: string): boolean {
    const set = this.subscribers.get(runId);
    return !!set && set.size > 0;
  }
}

@Injectable()
export class ResearchRunService {
  private readonly bus = new RunEventBus();

  /** RunIds currently in a non-terminal state (queued/running), tracked purely
   * in-memory so `isActive()` can answer synchronously without a DB round-trip.
   * Populated in `createRun`, cleared in `finalize`. This is per-process state:
   * it reflects runs driven by THIS backend instance, not a global "is any
   * process running this" fact — acceptable since the background research
   * agent that calls createRun/appendStep/finalize lives in this same process. */
  private readonly activeRunIds = new Set<string>();

  constructor(
    @InjectModel(ResearchRun.name)
    private readonly runModel: Model<ResearchRunDocument>,
  ) {}

  /**
   * Allocates the next per-topic run number (max existing `number` for this
   * topicId + 1, starting at 1) and creates the run in `running` status.
   *
   * Deliberately NOT routed through `CountersService`: that service scopes
   * counters by projectId/customerId (see `CounterScope`) and its `entity`
   * union doesn't include runs — a topic-scoped sequence doesn't fit its
   * shape. Instead this mirrors `ResearchRunSchema`'s own `{topicId:1,
   * number:-1}` index, which exists precisely to make this
   * findOne-sort-descending lookup cheap. There is a narrow race window
   * under concurrent run-creation for the SAME topic (read-then-write, no
   * upsert-and-increment), but scheduled and manual runs for one topic are
   * not expected to overlap in practice.
   */
  async createRun(topicId: string, trigger: 'scheduled' | 'manual'): Promise<ResearchRunDocument> {
    const topicObjectId = new Types.ObjectId(topicId);

    const last = await this.runModel
      .findOne({ topicId: topicObjectId }, { number: 1 })
      .sort({ number: -1 })
      .exec();
    const number = (last?.number ?? 0) + 1;

    const run = await this.runModel.create({
      topicId: topicObjectId,
      number,
      status: ResearchRunStatus.RUNNING,
      trigger,
      startedAt: new Date(),
      steps: [],
      artifactsCreated: [],
      artifactsUpdated: [],
    });

    const runId = run._id.toString();
    this.activeRunIds.add(runId);
    this.bus.publish(runId, { type: 'run_started', runId, number, trigger });
    return run;
  }

  /** Appends one step to the run's audit trail and fans it out to subscribers. */
  async appendStep(runId: string, step: RunStep): Promise<void> {
    const result = await this.runModel
      .updateOne({ _id: new Types.ObjectId(runId) }, { $push: { steps: step } })
      .exec();
    if (result.matchedCount === 0) {
      throw new NotFoundException(`ResearchRun ${runId} not found`);
    }
    this.bus.publish(runId, { type: 'step', step });
  }

  /**
   * Marks the run terminal (`done`/`error`/`cancelled`), stamps
   * `finishedAt`, persists the caller-supplied summary/artifacts/token-usage,
   * removes it from the in-memory active set, and publishes a `done` or
   * `error` bus event (any non-`error` terminal status — including
   * `cancelled` — is reported as `done`, matching the two-variant contract
   * `RunEvent['type']` documents for run completion).
   */
  async finalize(runId: string, patch: FinalizeRunPatch): Promise<void> {
    const update: Record<string, unknown> = {
      status: patch.status,
      finishedAt: new Date(),
    };
    if (patch.summary !== undefined) update.summary = patch.summary;
    if (patch.error !== undefined) update.error = patch.error;
    if (patch.artifactsCreated !== undefined) update.artifactsCreated = patch.artifactsCreated;
    if (patch.artifactsUpdated !== undefined) update.artifactsUpdated = patch.artifactsUpdated;
    if (patch.tokenUsage !== undefined) update.tokenUsage = patch.tokenUsage;

    const run = await this.runModel
      .findByIdAndUpdate(new Types.ObjectId(runId), { $set: update }, { new: true })
      .exec();
    if (!run) {
      throw new NotFoundException(`ResearchRun ${runId} not found`);
    }

    this.activeRunIds.delete(runId);

    const eventType = patch.status === ResearchRunStatus.ERROR ? 'error' : 'done';
    this.bus.publish(runId, {
      type: eventType,
      status: patch.status,
      summary: patch.summary,
      error: patch.error,
    });
  }

  subscribe(runId: string, cb: (event: RunEvent) => void): () => void {
    return this.bus.subscribe(runId, cb);
  }

  publish(runId: string, event: RunEvent): void {
    this.bus.publish(runId, event);
  }

  async getRun(id: string): Promise<ResearchRunDocument> {
    const run = await this.runModel.findById(id).exec();
    if (!run) {
      throw new NotFoundException(`ResearchRun ${id} not found`);
    }
    return run;
  }

  async listByTopic(topicId: string): Promise<ResearchRunDocument[]> {
    return this.runModel
      .find({ topicId: new Types.ObjectId(topicId) })
      .sort({ number: -1 })
      .exec();
  }

  /** True while `runId` is queued/running per this process's own bookkeeping (see `activeRunIds`). */
  isActive(runId: string): boolean {
    return this.activeRunIds.has(runId);
  }
}
