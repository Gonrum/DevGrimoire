import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Project, ProjectDocument } from './schemas/project.schema';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { PROJECT_CHANGED } from '../events/project-event';

@Injectable()
export class ProjectsService {
  constructor(
    @InjectModel(Project.name) private projectModel: Model<ProjectDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateProjectDto): Promise<ProjectDocument> {
    const project = await this.projectModel.create(dto);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: project._id.toString(),
      entity: 'project',
      action: 'created',
      entityId: project._id.toString(),
      summary: `Projekt "${project.name}" erstellt`,
    });
    return project;
  }

  async findAll(active?: boolean, favorite?: boolean): Promise<ProjectDocument[]> {
    const filter: Record<string, unknown> = {};
    if (active !== undefined) filter.active = active;
    if (favorite !== undefined) filter.favorite = favorite;
    return this.projectModel.find(filter).sort({ updatedAt: -1 }).exec();
  }

  async findById(id: string): Promise<ProjectDocument> {
    const project = await this.projectModel.findById(id).exec();
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    return project;
  }

  async findByName(name: string): Promise<ProjectDocument | null> {
    return this.projectModel.findOne({ name }).exec();
  }

  async update(id: string, dto: UpdateProjectDto): Promise<ProjectDocument> {
    const project = await this.projectModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: id,
      entity: 'project',
      action: 'updated',
      entityId: id,
      summary: `Projekt "${project.name}" aktualisiert`,
    });
    return project;
  }

  async remove(id: string): Promise<void> {
    const result = await this.projectModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Project ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: id,
      entity: 'project',
      action: 'deleted',
      entityId: id,
    });
  }
}
