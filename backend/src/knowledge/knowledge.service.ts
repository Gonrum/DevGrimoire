import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Knowledge, KnowledgeDocument } from './schemas/knowledge.schema';
import { CreateKnowledgeDto } from './dto/create-knowledge.dto';
import { UpdateKnowledgeDto } from './dto/update-knowledge.dto';
import { PROJECT_CHANGED } from '../events/project-event';

@Injectable()
export class KnowledgeService {
  constructor(
    @InjectModel(Knowledge.name)
    private knowledgeModel: Model<KnowledgeDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateKnowledgeDto): Promise<KnowledgeDocument> {
    const scope = dto.scope || (dto.projectId ? 'project' : 'global');
    if (scope === 'project' && !dto.projectId) {
      throw new BadRequestException('projectId is required for scope "project"');
    }
    const entry = await this.knowledgeModel.create({ ...dto, scope });
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: entry.projectId?.toString() || null,
      entity: 'knowledge',
      action: 'created',
      entityId: entry._id.toString(),
      summary: `Wissen "${entry.topic}" gespeichert (${scope})`,
    });
    return entry;
  }

  async findByProject(
    projectId: string | undefined,
    options?: { category?: string; scope?: string; limit?: number; offset?: number },
  ): Promise<KnowledgeDocument[]> {
    const filter: Record<string, unknown> = {};
    if (options?.scope === 'global') {
      filter.scope = 'global';
    } else if (options?.scope === 'project') {
      if (!projectId) throw new BadRequestException('projectId is required for scope "project"');
      filter.projectId = projectId;
      filter.scope = 'project';
    } else if (projectId) {
      // Default: show project-specific + global entries
      filter.$or = [{ projectId }, { scope: 'global' }];
    } else {
      // No projectId, no scope filter: return all
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
  ): Promise<KnowledgeDocument[]> {
    const filter: Record<string, unknown> = {
      $text: { $search: query },
    };
    if (scope === 'global') {
      filter.scope = 'global';
    } else if (scope === 'project' && projectId) {
      filter.projectId = projectId;
      filter.scope = 'project';
    } else if (projectId) {
      // Show project-specific + global results
      filter.$or = [{ projectId }, { scope: 'global' }];
      delete filter.projectId;
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
      entity: 'knowledge',
      action: 'deleted',
      entityId: id,
      summary: `Wissen "${result.topic}" gelöscht`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.knowledgeModel.deleteMany({ projectId }).exec();
  }
}
