import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import {
  DEFAULT_GUARDRAILS,
  ResearchGuardrails,
  ResearchSchedule,
  ResearchScope,
  ResearchTopic,
  ResearchTopicDocument,
  ResearchWebSearchConfig,
} from './schemas/research-topic.schema';
import { ResearchArtifact, ResearchArtifactDocument } from './schemas/research-artifact.schema';
import {
  ResearchArtifactVersion,
  ResearchArtifactVersionDocument,
} from './schemas/research-artifact-version.schema';
import { ResearchRun, ResearchRunDocument } from './schemas/research-run.schema';
import {
  CreateResearchTopicDto,
  ResearchGuardrailsDto,
  ResearchScopeDto,
  UpdateResearchTopicDto,
} from './dto/research-topic.dto';
import { CountersService } from '../counters/counters.service';
import { computeNextRun, nextStatusUpdate } from './research-schedule.util';

export interface ResearchTopicListFilter {
  active?: boolean;
  q?: string;
}

/**
 * Legt die vier Guardrails fest: gesetzter Wert gewinnt, sonst der Wert aus
 * `base`.
 *
 * Ersetzt ein generisches `definedOnly<T>()`, das `Object.keys(obj) as (keyof
 * T)[]` behaupten musste, weil `Object.keys` nur `string[]` liefert. Feldweise
 * ausgeschrieben braucht es die Behauptung nicht — und der Compiler prüft
 * dabei, dass alle vier Felder wirklich belegt sind, was der Spread
 * `{...base, ...definedOnly(dto)}` nur zugesagt hat.
 */
function mergeGuardrails(base: ResearchGuardrails, dto?: ResearchGuardrailsDto): ResearchGuardrails {
  return {
    maxIterations: dto?.maxIterations ?? base.maxIterations,
    maxWebSearches: dto?.maxWebSearches ?? base.maxWebSearches,
    maxWebFetches: dto?.maxWebFetches ?? base.maxWebFetches,
    timeoutMs: dto?.timeoutMs ?? base.timeoutMs,
  };
}

@Injectable()
export class ResearchTopicService {
  constructor(
    @InjectModel(ResearchTopic.name)
    private readonly topicModel: Model<ResearchTopicDocument>,
    @InjectModel(ResearchArtifact.name)
    private readonly artifactModel: Model<ResearchArtifactDocument>,
    @InjectModel(ResearchArtifactVersion.name)
    private readonly artifactVersionModel: Model<ResearchArtifactVersionDocument>,
    @InjectModel(ResearchRun.name)
    private readonly runModel: Model<ResearchRunDocument>,
    private readonly counters: CountersService,
  ) {}

  private buildScope(dto?: ResearchScopeDto): ResearchScope {
    const mode = dto?.mode ?? 'all';
    const scope: ResearchScope = {
      mode,
      projectIds: (dto?.projectIds || []).map((id) => new Types.ObjectId(id)),
      customerIds: (dto?.customerIds || []).map((id) => new Types.ObjectId(id)),
      // Mode-dependent default (final-review fix, F1): `mode: 'all'` is
      // already an unbounded sweep, so defaulting `includeGlobal` to `true`
      // there adds nothing extra. `mode: 'selected'` is an operator-curated,
      // deliberately narrow set of projects/customers — defaulting
      // `includeGlobal` to `true` there silently turns a focused topic into
      // a FULLY-UNSCOPED search across every project the owner can see (see
      // `RagService.searchScopes`'s `includeGlobal` branch), which is never
      // what "selected" was meant to express. An explicit caller-provided
      // value always wins over this default either way.
      includeGlobal: dto?.includeGlobal ?? mode === 'all',
    };
    this.validateScope(scope);
    return scope;
  }

  private validateScope(scope: ResearchScope): void {
    if (
      scope.mode === 'selected' &&
      scope.projectIds.length === 0 &&
      scope.customerIds.length === 0 &&
      !scope.includeGlobal
    ) {
      throw new BadRequestException(
        'scope.mode "selected" requires at least one projectId/customerId, or includeGlobal=true',
      );
    }
  }

  private buildGuardrails(dto?: ResearchGuardrailsDto): ResearchGuardrails {
    return mergeGuardrails(DEFAULT_GUARDRAILS, dto);
  }

  /**
   * `ownerUserId` MUST come exclusively from the trusted `ownerUserId` param
   * (the authenticated caller, as resolved by the controller) — never from
   * client-supplied DTO fields. The scheduled research agent later runs in
   * this user's RequestContext (their read scope/permissions), so accepting
   * a DTO override would let a low-privileged caller submit
   * `{ ownerUserId: '<admin id>' }` and have the agent run with admin scope.
   */
  private resolveOwnerUserId(ownerUserId: string): Types.ObjectId {
    if (!ownerUserId || !isValidObjectId(ownerUserId)) {
      throw new BadRequestException('ownerUserId is required and must be a valid ObjectId');
    }
    return new Types.ObjectId(ownerUserId);
  }

  async create(dto: CreateResearchTopicDto, ownerUserId: string): Promise<ResearchTopicDocument> {
    const scope = this.buildScope(dto.scope);
    const webSearch: ResearchWebSearchConfig = {
      enabled: dto.webSearch?.enabled ?? false,
      provider: dto.webSearch?.provider,
    };
    const guardrails = this.buildGuardrails(dto.guardrails);
    const owner = this.resolveOwnerUserId(ownerUserId);

    const active = dto.schedule.active ?? true;
    const now = new Date();
    const schedule: ResearchSchedule = {
      frequency: dto.schedule.frequency,
      hour: dto.schedule.hour,
      dayOfWeek: dto.schedule.dayOfWeek,
      dayOfMonth: dto.schedule.dayOfMonth,
      month: dto.schedule.month,
      active,
      nextRun: active ? computeNextRun(now, dto.schedule) : undefined,
    };

    // `number` MUST be resolved and set in this SAME `.create()` call.
    // ResearchTopicSchema's `{number:1}` index is a non-partial unique index
    // (no partialFilterExpression) — a document inserted without `number`
    // set would be treated as `number: null` and collide (E11000) with the
    // second such document.
    const seq = await this.counters.getNextSequence({}, 'research');
    const displayNumber = `R-${seq}`;

    return this.topicModel.create({
      number: seq,
      displayNumber,
      title: dto.title,
      brief: dto.brief,
      scope,
      webSearch,
      schedule,
      guardrails,
      ownerUserId: owner,
      notifyOnComplete: dto.notifyOnComplete ?? false,
    });
  }

  async list(filter?: ResearchTopicListFilter): Promise<ResearchTopicDocument[]> {
    const query: Record<string, unknown> = {};
    if (filter?.active !== undefined) query['schedule.active'] = filter.active;
    if (filter?.q) query.title = { $regex: filter.q, $options: 'i' };
    return this.topicModel.find(query).sort({ number: -1 }).exec();
  }

  async get(id: string): Promise<ResearchTopicDocument> {
    const topic = await this.topicModel.findById(id).exec();
    if (!topic) throw new NotFoundException(`ResearchTopic ${id} not found`);
    return topic;
  }

  async update(id: string, dto: UpdateResearchTopicDto): Promise<ResearchTopicDocument> {
    const topic = await this.get(id);

    if (dto.title !== undefined) topic.title = dto.title;
    if (dto.brief !== undefined) topic.brief = dto.brief;
    if (dto.notifyOnComplete !== undefined) topic.notifyOnComplete = dto.notifyOnComplete;

    if (dto.scope) {
      topic.scope = this.buildScope(dto.scope);
    }

    if (dto.webSearch) {
      topic.webSearch = { enabled: dto.webSearch.enabled, provider: dto.webSearch.provider };
    }

    if (dto.guardrails) {
      topic.guardrails = mergeGuardrails(topic.guardrails, dto.guardrails);
    }

    if (dto.schedule) {
      const existing = topic.schedule;
      const frequency = dto.schedule.frequency ?? existing.frequency;
      const hour = dto.schedule.hour ?? existing.hour;
      const dayOfWeek = dto.schedule.dayOfWeek !== undefined ? dto.schedule.dayOfWeek : existing.dayOfWeek;
      const dayOfMonth = dto.schedule.dayOfMonth !== undefined ? dto.schedule.dayOfMonth : existing.dayOfMonth;
      const month = dto.schedule.month !== undefined ? dto.schedule.month : existing.month;
      const active = dto.schedule.active !== undefined ? dto.schedule.active : existing.active;
      const nextRun = active
        ? computeNextRun(new Date(), { frequency, hour, dayOfWeek, dayOfMonth, month })
        : undefined;
      topic.schedule = {
        frequency,
        hour,
        dayOfWeek,
        dayOfMonth,
        month,
        active,
        nextRun,
        lastRun: existing.lastRun,
        lastRunStatus: existing.lastRunStatus,
      };
    }

    await topic.save();
    return topic;
  }

  /**
   * Active topics whose schedule is due to fire as of `now` — the selection
   * `ResearchScheduler.handleCron` polls every minute. Matches the compound
   * `{'schedule.active':1,'schedule.nextRun':1}` index on the schema.
   */
  async findDue(now: Date): Promise<ResearchTopicDocument[]> {
    return this.topicModel
      .find({
        'schedule.active': true,
        'schedule.nextRun': { $ne: null, $lte: now },
      })
      .sort({ 'schedule.nextRun': 1 })
      .exec();
  }

  /**
   * Persists one schedule-status patch: `lastRun`, `lastRunStatus`, and
   * `nextRun` (computed from `ranAt`, NOT from `Date.now()` — see
   * `nextStatusUpdate`'s doc comment for why this ordering matters).
   *
   * `ResearchScheduler` calls this TWICE per fired topic per tick, both times
   * with the SAME `ranAt` (the tick's own `now`): once up front — before
   * `ResearchAgentService.run` is invoked at all — with a provisional status,
   * and once more after the run settles (or is skipped) with the final
   * status. Because `nextStatusUpdate` derives `nextRun` purely from `ranAt`
   * and the schedule's frequency fields (neither of which the first call
   * changes), the second call recomputes the identical `nextRun` — it is
   * idempotent, not a second advance.
   */
  async markRun(topicId: string, ranAt: Date, status: string): Promise<void> {
    const topic = await this.get(topicId);
    const patch = nextStatusUpdate(topic, ranAt, status);
    await this.topicModel
      .updateOne(
        { _id: topic._id },
        {
          $set: {
            'schedule.lastRun': patch.lastRun,
            'schedule.lastRunStatus': patch.lastRunStatus,
            'schedule.nextRun': patch.nextRun,
          },
        },
      )
      .exec();
  }

  /** Cascade-delete the topic together with all its artifacts, artifact versions, and runs. */
  async remove(id: string): Promise<void> {
    const topic = await this.get(id);

    const artifacts = await this.artifactModel.find({ topicId: topic._id }, { _id: 1 }).exec();
    const artifactIds = artifacts.map((a) => a._id);
    if (artifactIds.length > 0) {
      await this.artifactVersionModel.deleteMany({ artifactId: { $in: artifactIds } }).exec();
    }
    await this.artifactModel.deleteMany({ topicId: topic._id }).exec();
    await this.runModel.deleteMany({ topicId: topic._id }).exec();
    await this.topicModel.deleteOne({ _id: topic._id }).exec();
  }
}
