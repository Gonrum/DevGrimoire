import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Knowledge, KnowledgeDocument } from './schemas/knowledge.schema';
import { CreateKnowledgeDto } from './dto/create-knowledge.dto';
import { UpdateKnowledgeDto } from './dto/update-knowledge.dto';

@Injectable()
export class KnowledgeService {
  constructor(
    @InjectModel(Knowledge.name)
    private knowledgeModel: Model<KnowledgeDocument>,
  ) {}

  async create(dto: CreateKnowledgeDto): Promise<KnowledgeDocument> {
    return this.knowledgeModel.create(dto);
  }

  async findByProject(projectId: string): Promise<KnowledgeDocument[]> {
    return this.knowledgeModel
      .find({ projectId })
      .sort({ updatedAt: -1 })
      .exec();
  }

  async search(
    query: string,
    projectId?: string,
  ): Promise<KnowledgeDocument[]> {
    const filter: Record<string, unknown> = {
      $text: { $search: query },
    };
    if (projectId) filter.projectId = projectId;
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
    return entry;
  }

  async remove(id: string): Promise<void> {
    const result = await this.knowledgeModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Knowledge ${id} not found`);
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.knowledgeModel.deleteMany({ projectId }).exec();
  }
}
