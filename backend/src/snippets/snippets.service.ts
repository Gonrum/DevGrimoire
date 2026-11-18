import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { Snippet, SnippetDocument } from './schemas/snippet.schema';
import { CreateSnippetDto } from './dto/create-snippet.dto';
import { UpdateSnippetDto } from './dto/update-snippet.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';
import { assertSafeCascadeId } from '../common/cascade-guard';
import {
  assertCustomerInScope,
  assertOwnerInScope,
  assertOwnerParamsInScope,
  assertProjectInScope,
  scopeFilter,
} from '../common/scope-guard';

@Injectable()
export class SnippetsService {
  constructor(
    @InjectModel(Snippet.name)
    private snippetModel: Model<SnippetDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateSnippetDto): Promise<SnippetDocument> {
    if (!dto.projectId && !dto.customerId) {
      throw new BadRequestException('projectId or customerId is required');
    }
    if (dto.projectId && dto.customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    // The customerId was never checked (the pipe only covers projectId).
    assertOwnerParamsInScope(dto);
    const snippet = await this.snippetModel.create(dto);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: snippet.projectId?.toString() || null,
      customerId: snippet.customerId?.toString() || null,
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
    assertProjectInScope(projectId);
    const filter: Record<string, unknown> = { projectId: projectIdFilter(projectId) };
    // Relation snippets also carry a customerId that must be in scope.
    Object.assign(filter, scopeFilter());
    if (language) filter.language = language;
    if (category) filter.category = category;
    if (tag) filter.tags = tag;
    return this.snippetModel.find(filter).sort({ updatedAt: -1 }).exec();
  }

  async findByCustomer(
    customerId: string,
    language?: string,
    category?: string,
    tag?: string,
  ): Promise<SnippetDocument[]> {
    assertCustomerInScope(customerId);
    const filter: Record<string, unknown> = { customerId: projectIdFilter(customerId) };
    Object.assign(filter, scopeFilter());
    if (language) filter.language = language;
    if (category) filter.category = category;
    if (tag) filter.tags = tag;
    return this.snippetModel.find(filter).sort({ updatedAt: -1 }).exec();
  }

  async search(
    query: string,
    projectId?: string,
    customerId?: string,
  ): Promise<SnippetDocument[]> {
    const filter: Record<string, unknown> = {
      $text: { $search: query },
    };
    assertOwnerParamsInScope({ projectId, customerId });
    if (projectId) filter.projectId = projectIdFilter(projectId);
    if (customerId) filter.customerId = projectIdFilter(customerId);
    // Without an owner param the text search used to cover every project and
    // customer — always restrict to the actor's scope.
    Object.assign(filter, scopeFilter());
    return this.snippetModel
      .find(filter, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .exec();
  }

  /** Load + 404 + scope check on both axes — every by-id path goes through here before mutating. */
  private async findScoped(id: string): Promise<SnippetDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException(`Snippet ${id} not found`);
    const snippet = await this.snippetModel.findById(id).exec();
    if (!snippet) throw new NotFoundException(`Snippet ${id} not found`);
    assertOwnerInScope({ projectId: snippet.projectId, customerId: snippet.customerId }, `Snippet ${id}`);
    return snippet;
  }

  async findById(id: string): Promise<SnippetDocument> {
    return this.findScoped(id);
  }

  async update(id: string, dto: UpdateSnippetDto): Promise<SnippetDocument> {
    const existing = await this.findScoped(id);
    const snippet = await this.snippetModel
      .findByIdAndUpdate(existing._id, dto, { new: true })
      .exec();
    if (!snippet) throw new NotFoundException(`Snippet ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: snippet.projectId?.toString() || null,
      customerId: snippet.customerId?.toString() || null,
      entity: 'snippet',
      action: 'updated',
      entityId: id,
      summary: `Snippet "${snippet.title}" aktualisiert`,
    });
    return snippet;
  }

  async remove(id: string): Promise<void> {
    const existing = await this.findScoped(id);
    const result = await this.snippetModel.findByIdAndDelete(existing._id).exec();
    if (!result) throw new NotFoundException(`Snippet ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId?.toString() || null,
      customerId: result.customerId?.toString() || null,
      entity: 'snippet',
      action: 'deleted',
      entityId: id,
      summary: `Snippet "${result.title}" gelöscht`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    assertSafeCascadeId(projectId, 'projectId');
    await this.snippetModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
    assertSafeCascadeId(customerId, 'customerId');
    await this.snippetModel.deleteMany({ customerId }).exec();
  }
}
