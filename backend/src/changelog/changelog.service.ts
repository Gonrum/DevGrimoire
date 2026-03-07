import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Changelog, ChangelogDocument } from './schemas/changelog.schema';
import { CreateChangelogDto } from './dto/create-changelog.dto';
import { UpdateChangelogDto } from './dto/update-changelog.dto';
import { PROJECT_CHANGED } from '../events/project-event';

@Injectable()
export class ChangelogService {
  constructor(
    @InjectModel(Changelog.name)
    private changelogModel: Model<ChangelogDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateChangelogDto): Promise<ChangelogDocument> {
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
    return this.changelogModel
      .find({ projectId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  async findById(id: string): Promise<ChangelogDocument> {
    const entry = await this.changelogModel.findById(id).exec();
    if (!entry) throw new NotFoundException(`Changelog ${id} not found`);
    return entry;
  }

  async update(id: string, dto: UpdateChangelogDto): Promise<ChangelogDocument> {
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
    await this.changelogModel.deleteMany({ projectId }).exec();
  }
}
