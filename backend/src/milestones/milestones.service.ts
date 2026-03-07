import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Milestone, MilestoneDocument, MilestoneStatus } from './schemas/milestone.schema';
import { CreateMilestoneDto } from './dto/create-milestone.dto';
import { UpdateMilestoneDto } from './dto/update-milestone.dto';
import { PROJECT_CHANGED } from '../events/project-event';

@Injectable()
export class MilestonesService {
  constructor(
    @InjectModel(Milestone.name) private milestoneModel: Model<MilestoneDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateMilestoneDto): Promise<MilestoneDocument> {
    const milestone = await this.milestoneModel.create(dto);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: milestone.projectId.toString(),
      entity: 'milestone',
      action: 'created',
      entityId: milestone._id.toString(),
      summary: `Milestone "${milestone.name}" erstellt`,
    });
    return milestone;
  }

  async findByProject(projectId: string, status?: MilestoneStatus): Promise<MilestoneDocument[]> {
    const query: Record<string, unknown> = { projectId };
    if (status) query.status = status;
    return this.milestoneModel.find(query).sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<MilestoneDocument> {
    const milestone = await this.milestoneModel.findById(id).exec();
    if (!milestone) throw new NotFoundException(`Milestone ${id} not found`);
    return milestone;
  }

  async update(id: string, dto: UpdateMilestoneDto): Promise<MilestoneDocument> {
    const milestone = await this.milestoneModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!milestone) throw new NotFoundException(`Milestone ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: milestone.projectId.toString(),
      entity: 'milestone',
      action: 'updated',
      entityId: id,
      summary: `Milestone "${milestone.name}" aktualisiert${dto.status ? ': Status → ' + dto.status : ''}`,
    });
    return milestone;
  }

  async remove(id: string): Promise<void> {
    const result = await this.milestoneModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Milestone ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId.toString(),
      entity: 'milestone',
      action: 'deleted',
      entityId: id,
      summary: `Milestone "${result.name}" gelöscht`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.milestoneModel.deleteMany({ projectId }).exec();
  }
}
