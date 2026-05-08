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
    return this.knowledgeModel
      .find(filter, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .exec();
  }

  async findById(id: string): Promise<KnowledgeDocument> {
    const entry = await this.knowledgeModel.findById(id).exec();
    if (!entry) throw new NotFoundException(`Knowledge ${id} not found`);
    return entry;
  }

  async update(
    id: string,
    dto: UpdateKnowledgeDto,
  ): Promise<KnowledgeDocument> {
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
    const result = await this.knowledgeModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Knowledge ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId?.toString() || null,
      customerId: result.customerId?.toString() || null,
      entity: 'knowledge',
      action: 'deleted',
      entityId: id,
      summary: `Wissen "${result.topic}" gelöscht`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.knowledgeModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
    await this.knowledgeModel.deleteMany({ customerId }).exec();
  }
}
