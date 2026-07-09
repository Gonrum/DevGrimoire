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
import { computeNextRun } from './research-schedule.util';

export interface ResearchTopicListFilter {
  active?: boolean;
  q?: string;
}

/** Strip `undefined` values so a partial-update spread never clobbers existing fields. */
function definedOnly<T extends object>(obj?: Partial<T>): Partial<T> {
  if (!obj) return {};
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
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
    const scope: ResearchScope = {
      mode: dto?.mode ?? 'all',
      projectIds: (dto?.projectIds || []).map((id) => new Types.ObjectId(id)),
      customerIds: (dto?.customerIds || []).map((id) => new Types.ObjectId(id)),
      includeGlobal: dto?.includeGlobal ?? true,
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
    return { ...DEFAULT_GUARDRAILS, ...definedOnly(dto) };
  }

  private resolveOwnerUserId(dtoOwnerUserId: string | undefined, fallback: string): Types.ObjectId {
    const raw = dtoOwnerUserId ?? fallback;
    if (!raw || !isValidObjectId(raw)) {
      throw new BadRequestException('ownerUserId is required and must be a valid ObjectId');
    }
    return new Types.ObjectId(raw);
  }

  async create(dto: CreateResearchTopicDto, ownerUserId: string): Promise<ResearchTopicDocument> {
    const scope = this.buildScope(dto.scope);
    const webSearch: ResearchWebSearchConfig = {
      enabled: dto.webSearch?.enabled ?? false,
      provider: dto.webSearch?.provider,
    };
    const guardrails = this.buildGuardrails(dto.guardrails);
    const owner = this.resolveOwnerUserId(dto.ownerUserId, ownerUserId);

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
    // second such document. Mirrors research-sessions.service.ts:87-96.
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
      topic.guardrails = { ...topic.guardrails, ...definedOnly(dto.guardrails) };
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
