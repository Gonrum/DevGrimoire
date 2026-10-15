import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FilterQuery, Model, Types } from 'mongoose';
import { Research, ResearchDocument } from './schemas/research.schema';
import { CreateResearchDto } from './dto/create-research.dto';
import { UpdateResearchDto } from './dto/update-research.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';
import { assertSafeCascadeId } from '../common/cascade-guard';
import { actorCanAccessCustomer, actorCanAccessProject } from '../common/permissions';
import { RequestContext } from '../common/request-context';
import { assertMoveTarget, canReadResearch, visibleResearchFilter } from './research-access';

@Injectable()
export class ResearchService {
  constructor(
    @InjectModel(Research.name)
    private researchModel: Model<ResearchDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateResearchDto): Promise<ResearchDocument> {
    const actor = RequestContext.getUser();
    assertMoveTarget(actor, dto);
    const ownerUserId = actor && Types.ObjectId.isValid(actor.userId) ? new Types.ObjectId(actor.userId) : null;
    const entry = await this.researchModel.create({ ...dto, status: 'done', ownerUserId });
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: entry.projectId?.toString() || null,
      customerId: entry.customerId?.toString() || null,
      entity: 'research',
      action: 'created',
      entityId: entry._id.toString(),
      summary: `Recherche "${entry.title}" gespeichert`,
    });
    return entry;
  }

  async findByProject(projectId: string): Promise<ResearchDocument[]> {
    const actor = RequestContext.getUser();
    if (actor && !actorCanAccessProject(actor, projectId)) throw new ForbiddenException('Kein Zugriff auf das Projekt');
    return this.researchModel.find({ projectId: projectIdFilter(projectId) }).sort({ updatedAt: -1 }).exec();
  }

  async findByCustomer(customerId: string): Promise<ResearchDocument[]> {
    const actor = RequestContext.getUser();
    if (actor && !actorCanAccessCustomer(actor, customerId)) throw new ForbiddenException('Kein Zugriff auf den Kunden');
    return this.researchModel.find({ customerId: projectIdFilter(customerId) }).sort({ updatedAt: -1 }).exec();
  }

  async search(query: string, projectId?: string, customerId?: string): Promise<ResearchDocument[]> {
    const filter: FilterQuery<Research> = { $text: { $search: query } };
    if (projectId) filter.projectId = projectIdFilter(projectId);
    if (customerId) filter.customerId = projectIdFilter(customerId);
    const visible = visibleResearchFilter(RequestContext.getUser());
    const scoped: FilterQuery<Research> = Object.keys(visible).length > 0 ? { $and: [filter, visible] } : filter;
    return this.researchModel
      .find(scoped, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .exec();
  }

  async findById(id: string): Promise<ResearchDocument> {
    const entry = await this.researchModel.findById(id).exec();
    if (!entry) throw new NotFoundException(`Research ${id} not found`);
    return entry;
  }

  /** Wie findById, aber 404 auch bei fehlendem Recht (keine Existenz-Auskunft). */
  async findVisibleById(id: string): Promise<ResearchDocument> {
    const entry = await this.findById(id);
    if (!canReadResearch(RequestContext.getUser(), entry)) {
      throw new NotFoundException(`Research ${id} not found`);
    }
    return entry;
  }

  /** Persönlicher Speicher: nicht zugeordnete Recherchen des Actors (Admin: alle). */
  async listMine(): Promise<ResearchDocument[]> {
    const actor = RequestContext.getUser();
    const filter: FilterQuery<Research> = { projectId: null, customerId: null };
    if (actor && actor.role !== 'admin') {
      if (!Types.ObjectId.isValid(actor.userId)) return [];
      filter.ownerUserId = new Types.ObjectId(actor.userId);
    }
    return this.researchModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async update(id: string, dto: UpdateResearchDto): Promise<ResearchDocument> {
    await this.findVisibleById(id);
    const entry = await this.researchModel.findByIdAndUpdate(id, dto, { new: true }).exec();
    if (!entry) throw new NotFoundException(`Research ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: entry.projectId?.toString() || null,
      customerId: entry.customerId?.toString() || null,
      entity: 'research',
      action: 'updated',
      entityId: id,
      summary: `Recherche "${entry.title}" aktualisiert`,
    });
    return entry;
  }

  async remove(id: string): Promise<void> {
    await this.findVisibleById(id);
    const result = await this.researchModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Research ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId?.toString() || null,
      customerId: result.customerId?.toString() || null,
      entity: 'research',
      action: 'deleted',
      entityId: id,
      summary: `Recherche "${result.title}" gelöscht`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    assertSafeCascadeId(projectId, 'projectId');
    await this.researchModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
    assertSafeCascadeId(customerId, 'customerId');
    await this.researchModel.deleteMany({ customerId }).exec();
  }
}
