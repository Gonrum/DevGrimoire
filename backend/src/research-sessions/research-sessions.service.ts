import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ResearchSession,
  ResearchSessionDocument,
  ResearchSessionStatus,
} from './schemas/research-session.schema';
import {
  ResearchStep,
  ResearchStepDocument,
  ResearchStepStatus,
} from './schemas/research-step.schema';
import { CreateResearchSessionDto } from './dto/create-research-session.dto';
import { UpdateResearchSessionDto } from './dto/update-research-session.dto';
import { CreateResearchStepDto } from './dto/create-research-step.dto';
import { UpdateResearchStepDto } from './dto/update-research-step.dto';
import { CountersService } from '../counters/counters.service';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { OnEvent } from '@nestjs/event-emitter';
import { RequestContext } from '../common/request-context';

const STATUS_ORDER: Record<ResearchSessionStatus, number> = {
  [ResearchSessionStatus.OPEN]: 0,
  [ResearchSessionStatus.IN_PROGRESS]: 1,
  [ResearchSessionStatus.DONE]: 2,
};

function validateTransition(
  current: ResearchSessionStatus | ResearchStepStatus,
  next: ResearchSessionStatus | ResearchStepStatus,
): void {
  if (current === next) return;
  const diff = STATUS_ORDER[next as ResearchSessionStatus] - STATUS_ORDER[current as ResearchSessionStatus];
  if (Math.abs(diff) !== 1) {
    throw new BadRequestException(
      `Invalid status transition ${current} → ${next}. Allowed: open → in_progress → done (one step at a time).`,
    );
  }
}

@Injectable()
export class ResearchSessionsService {
  constructor(
    @InjectModel(ResearchSession.name)
    private readonly sessionModel: Model<ResearchSessionDocument>,
    @InjectModel(ResearchStep.name)
    private readonly stepModel: Model<ResearchStepDocument>,
    private readonly counters: CountersService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private actorVisibleProjectIds(): Set<string> | null {
    const actor = RequestContext.getUser();
    if (!actor || !actor.projectScopeMode || actor.projectScopeMode === 'all') return null;
    if (actor.projectScopeMode === 'none') return new Set();
    return new Set((actor.allowedProjectIds || []).map(String));
  }

  private filterVisibleSession(session: ResearchSessionDocument): ResearchSessionDocument {
    const allowed = this.actorVisibleProjectIds();
    if (!allowed) return session;
    const sessionPids = session.projectIds.map((p) => p.toString());
    const hasOverlap = sessionPids.some((p) => allowed.has(p));
    if (!hasOverlap) {
      throw new ForbiddenException(`ResearchSession ${session._id} is out of scope`);
    }
    return session;
  }

  async createSession(dto: CreateResearchSessionDto): Promise<ResearchSessionDocument> {
    const seq = await this.counters.getNextSequence({}, 'research');
    const displayNumber = `R-${seq}`;
    const projectIds = (dto.projectIds || []).map((id) => new Types.ObjectId(id));
    const session = await this.sessionModel.create({
      title: dto.title,
      projectIds,
      number: seq,
      displayNumber,
    });
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: projectIds[0]?.toString() ?? '',
      entity: 'research_session',
      action: 'created',
      entityId: session._id.toString(),
      summary: `Recherche "${session.title}" gestartet`,
    });
    return session;
  }

  async listSessions(args: { status?: ResearchSessionStatus; q?: string }): Promise<ResearchSessionDocument[]> {
    const filter: Record<string, unknown> = {};
    if (args.status) filter.status = args.status;
    if (args.q) filter.title = { $regex: args.q, $options: 'i' };
    const allowed = this.actorVisibleProjectIds();
    if (allowed) {
      if (allowed.size === 0) return [];
      filter.projectIds = { $in: [...allowed].map((id) => new Types.ObjectId(id)) };
    }
    return this.sessionModel.find(filter).sort({ updatedAt: -1 }).exec();
  }

  async getSession(id: string): Promise<ResearchSessionDocument> {
    const session = await this.sessionModel.findById(id).exec();
    if (!session) throw new NotFoundException(`ResearchSession ${id} not found`);
    return this.filterVisibleSession(session);
  }

  async getSessionWithSteps(id: string): Promise<{
    session: ResearchSessionDocument;
    steps: ResearchStepDocument[];
  }> {
    const session = await this.getSession(id);
    const steps = await this.stepModel.find({ sessionId: session._id }).sort({ order: 1 }).exec();
    return { session, steps };
  }

  async updateSession(id: string, dto: UpdateResearchSessionDto): Promise<ResearchSessionDocument> {
    const session = await this.getSession(id);

    if (dto.status && dto.status !== session.status) {
      validateTransition(session.status, dto.status);
      if (dto.status === ResearchSessionStatus.DONE) {
        const openSteps = await this.stepModel.countDocuments({
          sessionId: session._id,
          status: { $ne: ResearchStepStatus.DONE },
        });
        if (openSteps > 0) {
          throw new BadRequestException(
            `Cannot mark session done: ${openSteps} step(s) are not yet done.`,
          );
        }
      }
      session.status = dto.status;
    }
    if (dto.title !== undefined) session.title = dto.title;
    if (dto.projectIds) session.projectIds = dto.projectIds.map((p) => new Types.ObjectId(p));
    await session.save();

    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: session.projectIds[0]?.toString() ?? '',
      entity: 'research_session',
      action: 'updated',
      entityId: session._id.toString(),
      summary: `Recherche "${session.title}" aktualisiert`,
    });
    return session;
  }

  async deleteSession(id: string): Promise<void> {
    const session = await this.getSession(id);
    await this.stepModel.deleteMany({ sessionId: session._id });
    await this.sessionModel.deleteOne({ _id: session._id });
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: session.projectIds[0]?.toString() ?? '',
      entity: 'research_session',
      action: 'deleted',
      entityId: session._id.toString(),
    });
  }

  // --- Steps ---

  async createStep(sessionId: string, dto: CreateResearchStepDto): Promise<ResearchStepDocument> {
    await this.getSession(sessionId);
    const order =
      dto.order !== undefined
        ? dto.order
        : ((await this.stepModel
            .find({ sessionId: new Types.ObjectId(sessionId) })
            .sort({ order: -1 })
            .limit(1)
            .exec())[0]?.order ?? -1) + 1;
    const step = await this.stepModel.create({
      sessionId: new Types.ObjectId(sessionId),
      title: dto.title,
      order,
    });
    return step;
  }

  async getStep(id: string): Promise<ResearchStepDocument> {
    const step = await this.stepModel.findById(id).exec();
    if (!step) throw new NotFoundException(`ResearchStep ${id} not found`);
    // Scope check via parent session.
    await this.getSession(step.sessionId.toString());
    return step;
  }

  async updateStep(id: string, dto: UpdateResearchStepDto): Promise<ResearchStepDocument> {
    const step = await this.getStep(id);

    if (dto.status && dto.status !== step.status) {
      validateTransition(step.status, dto.status);
      step.status = dto.status;
      // Auto-save trigger for `→ done` happens in Phase 4 via a separate hook in
      // this method. For now we just allow the transition.
    }
    if (dto.title !== undefined) step.title = dto.title;
    if (dto.order !== undefined) step.order = dto.order;
    await step.save();
    return step;
  }

  async deleteStep(id: string): Promise<void> {
    const step = await this.getStep(id);
    await this.stepModel.deleteOne({ _id: step._id });
  }

  /**
   * On project delete: drop the projectId from all sessions referencing it.
   * Sessions with no remaining projects are kept but become "context-less".
   */
  @OnEvent(PROJECT_CHANGED)
  async onProjectChange(event: ProjectChangeEvent): Promise<void> {
    if (event.entity !== 'project' || event.action !== 'deleted' || !event.projectId) return;
    if (!Types.ObjectId.isValid(event.projectId)) return;
    const pid = new Types.ObjectId(event.projectId);
    await this.sessionModel
      .updateMany({ projectIds: pid }, { $pull: { projectIds: pid } })
      .exec();
  }
}
