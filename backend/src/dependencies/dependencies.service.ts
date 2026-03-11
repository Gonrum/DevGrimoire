import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Dependency, DependencyDocument, PackageManager } from './schemas/dependency.schema';
import { CreateDependencyDto } from './dto/create-dependency.dto';
import { UpdateDependencyDto } from './dto/update-dependency.dto';
import { BulkCreateDependencyDto } from './dto/bulk-create-dependency.dto';
import { PROJECT_CHANGED } from '../events/project-event';

@Injectable()
export class DependenciesService {
  constructor(
    @InjectModel(Dependency.name) private dependencyModel: Model<DependencyDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateDependencyDto): Promise<DependencyDocument> {
    const dep = await this.dependencyModel.create(dto);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: dep.projectId.toString(),
      entity: 'dependency',
      action: 'created',
      entityId: dep._id.toString(),
      summary: `Dependency "${dep.name}@${dep.version}" (${dep.packageManager}) hinzugefügt`,
    });
    return dep;
  }

  async bulkCreate(dto: BulkCreateDependencyDto): Promise<{ created: number; updated: number; total: number }> {
    let created = 0;
    let updated = 0;

    for (const item of dto.dependencies) {
      const result = await this.dependencyModel.findOneAndUpdate(
        { projectId: dto.projectId, name: item.name, packageManager: dto.packageManager },
        {
          $set: {
            version: item.version,
            devDependency: item.devDependency ?? false,
          },
          $setOnInsert: {
            projectId: dto.projectId,
            name: item.name,
            packageManager: dto.packageManager,
            tags: [],
          },
        },
        { upsert: true, new: true, rawResult: true },
      ) as any;
      if (result.lastErrorObject?.updatedExisting) {
        updated++;
      } else {
        created++;
      }
    }

    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: dto.projectId,
      entity: 'dependency',
      action: 'created',
      summary: `Dependency-Scan: ${created} neu, ${updated} aktualisiert (${dto.packageManager})`,
    });

    return { created, updated, total: dto.dependencies.length };
  }

  async findByProject(
    projectId: string,
    filters?: { packageManager?: PackageManager; category?: string; devDependency?: boolean },
  ): Promise<DependencyDocument[]> {
    const query: Record<string, unknown> = { projectId };
    if (filters?.packageManager) query.packageManager = filters.packageManager;
    if (filters?.category) query.category = filters.category;
    if (filters?.devDependency !== undefined) query.devDependency = filters.devDependency;
    return this.dependencyModel.find(query).sort({ name: 1 }).exec();
  }

  async findById(id: string): Promise<DependencyDocument> {
    const dep = await this.dependencyModel.findById(id).exec();
    if (!dep) throw new NotFoundException(`Dependency ${id} not found`);
    return dep;
  }

  async update(id: string, dto: UpdateDependencyDto): Promise<DependencyDocument> {
    const dep = await this.dependencyModel.findByIdAndUpdate(id, dto, { new: true }).exec();
    if (!dep) throw new NotFoundException(`Dependency ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: dep.projectId.toString(),
      entity: 'dependency',
      action: 'updated',
      entityId: id,
      summary: `Dependency "${dep.name}" aktualisiert`,
    });
    return dep;
  }

  async remove(id: string): Promise<void> {
    const result = await this.dependencyModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Dependency ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId.toString(),
      entity: 'dependency',
      action: 'deleted',
      entityId: id,
      summary: `Dependency "${result.name}" entfernt`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.dependencyModel.deleteMany({ projectId }).exec();
  }
}
