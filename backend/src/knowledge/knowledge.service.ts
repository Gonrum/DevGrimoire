import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Knowledge, KnowledgeDocument } from './schemas/knowledge.schema';
import { CreateKnowledgeDto } from './dto/create-knowledge.dto';
import { UpdateKnowledgeDto } from './dto/update-knowledge.dto';
import { CustomersService } from '../customers/customers.service';
import { PROJECT_CHANGED } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';
import { assertSafeCascadeId } from '../common/cascade-guard';
import {
  assertOwnerInScope,
  assertOwnerParamsInScope,
  assertOwnerPermission,
  assertUnrestrictedScope,
  scopeAndPermissionFilter,
} from '../common/scope-guard';

@Injectable()
export class KnowledgeService {
  constructor(
    @InjectModel(Knowledge.name)
    private knowledgeModel: Model<KnowledgeDocument>,
    private customersService: CustomersService,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateKnowledgeDto): Promise<KnowledgeDocument> {
    const scope = dto.scope || (dto.customerId ? 'customer' : dto.projectId ? 'project' : 'global');
    if (scope === 'project' && !dto.projectId) {
      throw new BadRequestException('projectId is required for scope "project"');
    }
    if (scope === 'customer' && !dto.customerId) {
      throw new BadRequestException('customerId is required for scope "customer"');
    }
    // Checked here, not only in the controller pipe: notes promotion and
    // recurring tasks call create() directly. Every id that is present is
    // checked — also a customerId riding along on a 'project' entry.
    assertOwnerParamsInScope({ projectId: dto.projectId, customerId: dto.customerId });
    assertOwnerPermission({ projectId: dto.projectId, customerId: dto.customerId }, 'knowledge', 'write');
    // Global knowledge flows into every project's context and RAG — a narrowed
    // actor must not be able to inject content there.
    if (scope === 'global') assertUnrestrictedScope('Global knowledge');
    if (scope === 'customer') {
      await this.customersService.findById(dto.customerId!);
    }
    const entry = await this.knowledgeModel.create({ ...dto, scope });
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: entry.projectId?.toString() || null,
      customerId: entry.customerId?.toString() || null,
      entity: 'knowledge',
      action: 'created',
      entityId: entry._id.toString(),
      summary: `Wissen "${entry.topic}" gespeichert (${scope})`,
    });
    return entry;
  }

  async findByProject(
    projectId: string | undefined,
    options?: { customerId?: string; category?: string; scope?: string; limit?: number; offset?: number },
  ): Promise<KnowledgeDocument[]> {
    const filter: Record<string, unknown> = {};
    const customerId = options?.customerId;
    if (options?.scope === 'global') {
      filter.scope = 'global';
    } else if (options?.scope === 'project') {
      if (!projectId) throw new BadRequestException('projectId is required for scope "project"');
      filter.projectId = projectIdFilter(projectId);
      filter.scope = 'project';
    } else if (options?.scope === 'customer') {
      if (!customerId) throw new BadRequestException('customerId is required for scope "customer"');
      filter.customerId = projectIdFilter(customerId);
      filter.scope = 'customer';
    } else if (customerId) {
      // Default for customer view: customer-scoped + global
      filter.$or = [{ customerId: projectIdFilter(customerId) }, { scope: 'global' }];
    } else if (projectId) {
      // Default for project view: project-specific + global
      filter.$or = [{ projectId: projectIdFilter(projectId) }, { scope: 'global' }];
    } else {
      // No projectId/customerId, no scope filter: return all
    }
    if (options?.category) filter.category = options.category;
    Object.assign(filter, scopeAndPermissionFilter('knowledge'));
    let query = this.knowledgeModel.find(filter).sort({ updatedAt: -1 });
    if (options?.offset) query = query.skip(options.offset);
    if (options?.limit) query = query.limit(options.limit);
    return query.exec();
  }

  async search(
    query: string,
    projectId?: string,
    scope?: string,
    customerId?: string,
  ): Promise<KnowledgeDocument[]> {
    const filter: Record<string, unknown> = {
      $text: { $search: query },
    };
    if (scope === 'global') {
      filter.scope = 'global';
    } else if (scope === 'project' && projectId) {
      filter.projectId = projectIdFilter(projectId);
      filter.scope = 'project';
    } else if (scope === 'customer' && customerId) {
      filter.customerId = projectIdFilter(customerId);
      filter.scope = 'customer';
    } else if (customerId) {
      // Customer view: customer-scoped + global hits
      filter.$or = [{ customerId: projectIdFilter(customerId) }, { scope: 'global' }];
    } else if (projectId) {
      // Project view: project-scoped + global hits
      filter.$or = [{ projectId: projectIdFilter(projectId) }, { scope: 'global' }];
    }
    Object.assign(filter, scopeAndPermissionFilter('knowledge'));
    return this.knowledgeModel
      .find(filter, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .exec();
  }

  /**
   * Projekt-/Kunden-Scope-Prüfung (T-210/T-220). Stand vorher ausschließlich in
   * findById(); update() und remove() gingen direkt auf findByIdAndUpdate bzw.
   * findByIdAndDelete — ein verengter Actor konnte damit fremde
   * Wissenseinträge überschreiben und löschen, und über UpdateKnowledgeDto
   * zusätzlich `projectId`/`scope` umsetzen.
   *
   * `if (actor)` ist die dokumentierte Konvention (siehe AttachmentsService).
   */
  private assertAccess(entry: KnowledgeDocument, action: 'read' | 'write' = 'read'): void {
    const owner = { projectId: entry.projectId, customerId: entry.customerId };
    assertOwnerInScope(owner, `Knowledge ${entry._id.toString()}`);
    assertOwnerPermission(owner, 'knowledge', action);
  }

  /** Lädt, prüft 404 und Scope — die eine Stelle, die jeder Pfad benutzt. */
  private async findScoped(id: string, action: 'read' | 'write' = 'read'): Promise<KnowledgeDocument> {
    const entry = await this.knowledgeModel.findById(id).exec();
    if (!entry) throw new NotFoundException(`Knowledge ${id} not found`);
    this.assertAccess(entry, action);
    return entry;
  }

  /**
   * Write variant: an entry without any owner axis (or explicitly global)
   * passes assertAccess for everyone, yet it is visible in every project.
   * Changing or deleting it therefore requires an unrestricted actor.
   */
  private async findScopedForWrite(id: string): Promise<KnowledgeDocument> {
    const entry = await this.findScoped(id, 'write');
    const isGlobal = entry.scope === 'global' || (!entry.projectId && !entry.customerId);
    if (isGlobal) assertUnrestrictedScope('Global knowledge');
    return entry;
  }

  async findById(id: string): Promise<KnowledgeDocument> {
    return this.findScoped(id);
  }

  async update(
    id: string,
    dto: UpdateKnowledgeDto,
  ): Promise<KnowledgeDocument> {
    // VOR der Mutation prüfen — findByIdAndUpdate hätte sonst schon geschrieben.
    await this.findScopedForWrite(id);
    const entry = await this.knowledgeModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!entry) throw new NotFoundException(`Knowledge ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: entry.projectId?.toString() || null,
      customerId: entry.customerId?.toString() || null,
      entity: 'knowledge',
      action: 'updated',
      entityId: id,
      summary: `Wissen "${entry.topic}" aktualisiert`,
    });
    return entry;
  }

  async remove(id: string): Promise<void> {
    // VOR dem Löschen prüfen; das geladene Dokument trägt alles für das Event.
    const existing = await this.findScopedForWrite(id);
    await this.knowledgeModel.deleteOne({ _id: existing._id }).exec();
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: existing.projectId?.toString() || null,
      customerId: existing.customerId?.toString() || null,
      entity: 'knowledge',
      action: 'deleted',
      entityId: id,
      summary: `Wissen "${existing.topic}" gelöscht`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    assertSafeCascadeId(projectId, 'projectId');
    await this.knowledgeModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
    assertSafeCascadeId(customerId, 'customerId');
    await this.knowledgeModel.deleteMany({ customerId }).exec();
  }
}
