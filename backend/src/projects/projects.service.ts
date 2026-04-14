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

  /**
   * Set or clear the per-project replication opt-in flag. Used by the
   * replication controller's project-config endpoint. Returns the updated
   * project so the caller can forward the new state to the UI.
   */
  async setReplicationEnabled(id: string, enabled: boolean): Promise<ProjectDocument> {
    const project = await this.projectModel
      .findByIdAndUpdate(id, { replicationConfig: { enabled } }, { new: true })
      .exec();
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: id,
      entity: 'project',
      action: 'updated',
      entityId: id,
      summary: `Replikation für "${project.name}" ${enabled ? 'aktiviert' : 'deaktiviert'}`,
    });
    return project;
  }

  /** Returns true if the project is opted in for replication. Used as a fast
   *  filter by push/receive/full-sync services — avoids `findById` overhead
   *  by only projecting the single field. */
  async isReplicationEnabled(id: string): Promise<boolean> {
    const project = await this.projectModel
      .findById(id)
      .select('replicationConfig')
      .lean<{ replicationConfig?: { enabled?: boolean } } | null>()
      .exec();
    return !!project?.replicationConfig?.enabled;
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

  async updateRaw(id: string, update: Record<string, unknown>): Promise<ProjectDocument> {
    const project = await this.projectModel
      .findByIdAndUpdate(id, update, { new: true })
      .exec();
    if (!project) throw new NotFoundException(`Project ${id} not found`);
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
