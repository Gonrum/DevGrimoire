import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Research, ResearchDocument } from './schemas/research.schema';
import { CreateResearchDto } from './dto/create-research.dto';
import { UpdateResearchDto } from './dto/update-research.dto';
import { PROJECT_CHANGED } from '../events/project-event';

@Injectable()
export class ResearchService {
  constructor(
    @InjectModel(Research.name)
    private researchModel: Model<ResearchDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateResearchDto): Promise<ResearchDocument> {
    const entry = await this.researchModel.create(dto);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: entry.projectId.toString(),
      entity: 'research',
      action: 'created',
      entityId: entry._id.toString(),
      summary: `Recherche "${entry.title}" gespeichert`,
    });
    return entry;
  }

  async findByProject(projectId: string): Promise<ResearchDocument[]> {
    return this.researchModel.find({ projectId }).sort({ updatedAt: -1 }).exec();
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
      projectId: entry.projectId.toString(),
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
      projectId: result.projectId.toString(),
      entity: 'research',
      action: 'deleted',
      entityId: id,
      summary: `Recherche "${result.title}" gelöscht`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.researchModel.deleteMany({ projectId }).exec();
  }
}
