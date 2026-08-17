import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { errorMessage } from '../common/narrow';
import {
  ChatActivity,
  ChatActivityDocument,
  ChatActivityOutcome,
  ChatActivityToolUse,
} from './schemas/chat-activity.schema';

export interface RecordChatActivityInput {
  sessionId?: string;
  userId?: string;
  projectId?: string;
  customerId?: string;
  mode: 'server' | 'browser';
  provider?: string;
  endpointUrl?: string;
  model?: string;
  toolsEnabled: boolean;
  toolsUsed?: ChatActivityToolUse[];
  outcome: ChatActivityOutcome;
  errorMessage?: string;
  outputTokens?: number;
  durationMs?: number;
  firstTokenMs?: number;
  tokensPerSecond?: number;
  estimated?: boolean;
  hadImages?: boolean;
  userMessageLength?: number;
}

export interface ListChatActivityOptions {
  projectId?: string;
  sessionId?: string;
  outcome?: ChatActivityOutcome;
  provider?: string;
  search?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

@Injectable()
export class ChatActivityService {
  private readonly logger = new Logger(ChatActivityService.name);

  constructor(
    @InjectModel(ChatActivity.name)
    private readonly model: Model<ChatActivityDocument>,
  ) {}

  /**
   * Record a chat invocation outcome. Errors are caught and logged so a logging
   * failure can never break the active user request.
   */
  async record(input: RecordChatActivityInput): Promise<void> {
    try {
      await this.model.create({
        sessionId: input.sessionId ? new Types.ObjectId(input.sessionId) : undefined,
        userId: input.userId ? new Types.ObjectId(input.userId) : undefined,
        projectId: input.projectId ? new Types.ObjectId(input.projectId) : undefined,
        customerId: input.customerId ? new Types.ObjectId(input.customerId) : undefined,
        mode: input.mode,
        provider: input.provider,
        endpointUrl: input.endpointUrl,
        model: input.model,
        toolsEnabled: input.toolsEnabled,
        toolsUsed: input.toolsUsed && input.toolsUsed.length > 0 ? input.toolsUsed : undefined,
        outcome: input.outcome,
        errorMessage: input.errorMessage?.slice(0, 1000),
        outputTokens: input.outputTokens,
        durationMs: input.durationMs,
        firstTokenMs: input.firstTokenMs,
        tokensPerSecond: input.tokensPerSecond,
        estimated: input.estimated,
        hadImages: input.hadImages ?? false,
        userMessageLength: input.userMessageLength,
      });
    } catch (err: unknown) {
      this.logger.warn(`Failed to record chat activity: ${errorMessage(err)}`);
    }
  }

  async list(options: ListChatActivityOptions = {}): Promise<{
    items: ChatActivityDocument[];
    total: number;
  }> {
    const filter: FilterQuery<ChatActivityDocument> = {};
    if (options.projectId) filter.projectId = new Types.ObjectId(options.projectId);
    if (options.sessionId) filter.sessionId = new Types.ObjectId(options.sessionId);
    if (options.outcome) filter.outcome = options.outcome;
    if (options.provider) filter.provider = options.provider;
    if (options.startDate || options.endDate) {
      // Erst das Bereichsobjekt bauen, dann setzen — statt das leere Objekt in
      // den Filter zu legen und per Assertion nachzufüllen. Die Grenzen werden
      // nur gesetzt, wenn sie vorhanden sind: ein `$gte: undefined` würde von
      // Mongoose aus der Query entfernt und die Abfrage still weiten.
      const createdAt: { $gte?: Date; $lte?: Date } = {};
      if (options.startDate) createdAt.$gte = options.startDate;
      if (options.endDate) createdAt.$lte = options.endDate;
      filter.createdAt = createdAt;
    }
    if (options.search) {
      const rx = new RegExp(this.escapeRegex(options.search), 'i');
      filter.$or = [
        { errorMessage: rx },
        { model: rx },
        { endpointUrl: rx },
      ];
    }

    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const offset = Math.max(0, options.offset ?? 0);

    const [items, total] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).exec(),
      this.model.countDocuments(filter).exec(),
    ]);

    return { items, total };
  }

  async stats(options: { projectId?: string; days?: number } = {}): Promise<{
    total: number;
    completed: number;
    failed: number;
    aborted: number;
    noEndpoint: number;
    byProvider: Array<{ provider: string; count: number; failures: number }>;
    byTool: Array<{ name: string; count: number; errors: number }>;
    avgTokensPerSecond: number | null;
    avgFirstTokenMs: number | null;
  }> {
    const filter: FilterQuery<ChatActivityDocument> = {};
    if (options.projectId) filter.projectId = new Types.ObjectId(options.projectId);
    if (options.days && options.days > 0) {
      const since = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);
      filter.createdAt = { $gte: since };
    }

    const all = await this.model.find(filter).lean().exec();
    const stats = {
      total: all.length,
      completed: 0,
      failed: 0,
      aborted: 0,
      noEndpoint: 0,
      byProvider: new Map<string, { count: number; failures: number }>(),
      byTool: new Map<string, { count: number; errors: number }>(),
      tpsValues: [] as number[],
      ftMsValues: [] as number[],
    };

    for (const a of all) {
      if (a.outcome === 'completed') stats.completed++;
      else if (a.outcome === 'failed') stats.failed++;
      else if (a.outcome === 'aborted') stats.aborted++;
      else if (a.outcome === 'no_endpoint') stats.noEndpoint++;

      if (a.provider) {
        const p = stats.byProvider.get(a.provider) ?? { count: 0, failures: 0 };
        p.count++;
        if (a.outcome === 'failed' || a.outcome === 'no_endpoint') p.failures++;
        stats.byProvider.set(a.provider, p);
      }
      if (a.toolsUsed) {
        for (const tu of a.toolsUsed) {
          const t = stats.byTool.get(tu.name) ?? { count: 0, errors: 0 };
          t.count += tu.count;
          t.errors += tu.errors;
          stats.byTool.set(tu.name, t);
        }
      }
      if (typeof a.tokensPerSecond === 'number' && a.tokensPerSecond > 0) {
        stats.tpsValues.push(a.tokensPerSecond);
      }
      if (typeof a.firstTokenMs === 'number' && a.firstTokenMs > 0) {
        stats.ftMsValues.push(a.firstTokenMs);
      }
    }

    const avg = (xs: number[]) => (xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));

    return {
      total: stats.total,
      completed: stats.completed,
      failed: stats.failed,
      aborted: stats.aborted,
      noEndpoint: stats.noEndpoint,
      byProvider: Array.from(stats.byProvider.entries())
        .map(([provider, v]) => ({ provider, count: v.count, failures: v.failures }))
        .sort((a, b) => b.count - a.count),
      byTool: Array.from(stats.byTool.entries())
        .map(([name, v]) => ({ name, count: v.count, errors: v.errors }))
        .sort((a, b) => b.count - a.count),
      avgTokensPerSecond: avg(stats.tpsValues),
      avgFirstTokenMs: avg(stats.ftMsValues),
    };
  }

  /** Delete all activity older than the given number of days. */
  async cleanup(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const res = await this.model.deleteMany({ createdAt: { $lt: cutoff } }).exec();
    return res.deletedCount ?? 0;
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
