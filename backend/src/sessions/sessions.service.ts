import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Session, SessionDocument } from './schemas/session.schema';
import { CreateSessionDto } from './dto/create-session.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';
import { assertSafeCascadeId } from '../common/cascade-guard';
import { assertOwnerInScope, assertProjectInScope } from '../common/scope-guard';

@Injectable()
export class SessionsService {
  constructor(
    @InjectModel(Session.name) private sessionModel: Model<SessionDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateSessionDto): Promise<SessionDocument> {
    // Sessions feed the next agent's context — no writing into foreign projects.
    assertProjectInScope(dto.projectId);
    const session = await this.sessionModel.create(dto);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: session.projectId.toString(),
      entity: 'session',
      action: 'created',
      entityId: session._id.toString(),
      summary: `Session gespeichert: ${session.summary.substring(0, 80)}`,
    });
    return session;
  }

  async findByProject(
    projectId: string,
    limit = 10,
  ): Promise<SessionDocument[]> {
    assertProjectInScope(projectId);
    return this.sessionModel
      .find({ projectId: projectIdFilter(projectId) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  async findLatest(projectId: string): Promise<SessionDocument | null> {
    assertProjectInScope(projectId);
    return this.sessionModel
      .findOne({ projectId: projectIdFilter(projectId) })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findById(id: string): Promise<SessionDocument> {
    const session = await this.sessionModel.findById(id).exec();
    if (!session) throw new NotFoundException(`Session ${id} not found`);
    // Sessions are project-bound and have no owner user — the project decides.
    assertOwnerInScope({ projectId: session.projectId }, `Session ${id}`);
    return session;
  }

  async removeByProject(projectId: string): Promise<void> {
    assertSafeCascadeId(projectId, 'projectId');
    await this.sessionModel.deleteMany({ projectId }).exec();
  }
}
