import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Snippet, SnippetDocument } from './schemas/snippet.schema';
import { CreateSnippetDto } from './dto/create-snippet.dto';
import { UpdateSnippetDto } from './dto/update-snippet.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';

@Injectable()
export class SnippetsService {
  constructor(
    @InjectModel(Snippet.name)
    private snippetModel: Model<SnippetDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateSnippetDto): Promise<SnippetDocument> {
    const snippet = await this.snippetModel.create(dto);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: snippet.projectId.toString(),
      entity: 'snippet',
      action: 'created',
      entityId: snippet._id.toString(),
      summary: `Snippet "${snippet.title}" erstellt`,
    });
    return snippet;
  }

  async findByProject(
    projectId: string,
    language?: string,
    category?: string,
    tag?: string,
  ): Promise<SnippetDocument[]> {
    const filter: Record<string, unknown> = { projectId: projectIdFilter(projectId) };
    if (language) filter.language = language;
    if (category) filter.category = category;
    if (tag) filter.tags = tag;
    return this.snippetModel.find(filter).sort({ updatedAt: -1 }).exec();
  }

  async search(
    query: string,
    projectId?: string,
  ): Promise<SnippetDocument[]> {
    const filter: Record<string, unknown> = {
      $text: { $search: query },
    };
    if (projectId) filter.projectId = projectIdFilter(projectId);
    return this.snippetModel
      .find(filter, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .exec();
  }

  async findById(id: string): Promise<SnippetDocument> {
    const snippet = await this.snippetModel.findById(id).exec();
    if (!snippet) throw new NotFoundException(`Snippet ${id} not found`);
    return snippet;
  }

  async update(id: string, dto: UpdateSnippetDto): Promise<SnippetDocument> {
    const snippet = await this.snippetModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!snippet) throw new NotFoundException(`Snippet ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: snippet.projectId.toString(),
      entity: 'snippet',
      action: 'updated',
      entityId: id,
      summary: `Snippet "${snippet.title}" aktualisiert`,
    });
    return snippet;
  }

  async remove(id: string): Promise<void> {
    const result = await this.snippetModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Snippet ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId.toString(),
      entity: 'snippet',
      action: 'deleted',
      entityId: id,
      summary: `Snippet "${result.title}" gelöscht`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.snippetModel.deleteMany({ projectId }).exec();
  }
}
