import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Research, ResearchDocument } from './schemas/research.schema';
import { CreateResearchDto } from './dto/create-research.dto';
import { UpdateResearchDto } from './dto/update-research.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';

@Injectable()
export class ResearchService {
  constructor(
    @InjectModel(Research.name)
    private researchModel: Model<ResearchDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateResearchDto): Promise<ResearchDocument> {
    if (!dto.projectId && !dto.customerId) {
      throw new BadRequestException('projectId or customerId is required');
    }
    if (dto.projectId && dto.customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    const entry = await this.researchModel.create(dto);
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
    return this.researchModel.find({ projectId: projectIdFilter(projectId) }).sort({ updatedAt: -1 }).exec();
  }

  async findByCustomer(customerId: string): Promise<ResearchDocument[]> {
    return this.researchModel.find({ customerId: projectIdFilter(customerId) }).sort({ updatedAt: -1 }).exec();
  }

  async search(query: string, projectId?: string, customerId?: string): Promise<ResearchDocument[]> {
    const filter: Record<string, unknown> = { $text: { $search: query } };
    if (projectId) filter.projectId = projectIdFilter(projectId);
    if (customerId) filter.customerId = projectIdFilter(customerId);
    return this.researchModel
      .find(filter, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .exec();
  }

  async findById(id: string): Promise<ResearchDocument> {
    const entry = await this.researchModel.findById(id).exec();
    if (!entry) throw new NotFoundException(`Research ${id} not found`);
    return entry;
  }

  async update(id: string, dto: UpdateResearchDto): Promise<ResearchDocument> {
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
    await this.researchModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
    await this.researchModel.deleteMany({ customerId }).exec();
  }
}
