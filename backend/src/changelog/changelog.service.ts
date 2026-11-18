import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { Changelog, ChangelogDocument } from './schemas/changelog.schema';
import { CreateChangelogDto } from './dto/create-changelog.dto';
import { UpdateChangelogDto } from './dto/update-changelog.dto';
import { PROJECT_CHANGED } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';
import { assertSafeCascadeId } from '../common/cascade-guard';
import { assertOwnerInScope, assertProjectInScope } from '../common/scope-guard';

@Injectable()
export class ChangelogService {
  constructor(
    @InjectModel(Changelog.name)
    private changelogModel: Model<ChangelogDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateChangelogDto): Promise<ChangelogDocument> {
    // Internal callers (no actor) pass; a narrowed actor must not write into foreign projects.
    assertProjectInScope(dto.projectId);
    const entry = await this.changelogModel.create(dto);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: entry.projectId.toString(),
      entity: 'changelog',
      action: 'created',
      entityId: entry._id.toString(),
      summary: `Changelog${entry.version ? ' v' + entry.version : ''}: ${entry.summary || entry.changes[0] || 'Eintrag erstellt'}`,
    });
    return entry;
  }

  async findByProject(
    projectId: string,
    limit = 50,
  ): Promise<ChangelogDocument[]> {
    assertProjectInScope(projectId);
    return this.changelogModel
      .find({ projectId: projectIdFilter(projectId) })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  /** Load + 404 + scope check — every by-id path goes through here before mutating. */
  private async findScoped(id: string): Promise<ChangelogDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException(`Changelog ${id} not found`);
    const entry = await this.changelogModel.findById(id).exec();
    if (!entry) throw new NotFoundException(`Changelog ${id} not found`);
    assertOwnerInScope({ projectId: entry.projectId }, `Changelog ${id}`);
    return entry;
  }

  async findById(id: string): Promise<ChangelogDocument> {
    return this.findScoped(id);
  }

  async update(id: string, dto: UpdateChangelogDto): Promise<ChangelogDocument> {
    await this.findScoped(id);
    const entry = await this.changelogModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true })
      .exec();
    if (!entry) throw new NotFoundException(`Changelog ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: entry.projectId.toString(),
      entity: 'changelog',
      action: 'updated',
      entityId: id,
    });
    return entry;
  }

  async remove(id: string): Promise<void> {
    await this.findScoped(id);
    const result = await this.changelogModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Changelog ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId.toString(),
      entity: 'changelog',
      action: 'deleted',
      entityId: id,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    assertSafeCascadeId(projectId, 'projectId');
    await this.changelogModel.deleteMany({ projectId }).exec();
  }
}
