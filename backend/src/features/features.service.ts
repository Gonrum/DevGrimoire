import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Feature, FeatureDocument, FeatureStatus } from './schemas/feature.schema';
import { CreateFeatureDto } from './dto/create-feature.dto';
import { UpdateFeatureDto } from './dto/update-feature.dto';
import { PROJECT_CHANGED } from '../events/project-event';

@Injectable()
export class FeaturesService {
  constructor(
    @InjectModel(Feature.name) private featureModel: Model<FeatureDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateFeatureDto): Promise<FeatureDocument> {
    const feature = await this.featureModel.create(dto);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: feature.projectId.toString(),
      entity: 'feature',
      action: 'created',
      entityId: feature._id.toString(),
      summary: `Feature "${feature.name}" hinzugefügt`,
    });
    return feature;
  }

  async findByProject(
    projectId: string,
    filters?: { status?: FeatureStatus; category?: string },
  ): Promise<FeatureDocument[]> {
    const query: Record<string, unknown> = { projectId };
    if (filters?.status) query.status = filters.status;
    if (filters?.category) query.category = filters.category;
    return this.featureModel.find(query).sort({ status: 1, name: 1 }).exec();
  }

  async findById(id: string): Promise<FeatureDocument> {
    const feature = await this.featureModel.findById(id).exec();
    if (!feature) throw new NotFoundException(`Feature ${id} not found`);
    return feature;
  }

  async update(id: string, dto: UpdateFeatureDto): Promise<FeatureDocument> {
    const feature = await this.featureModel.findByIdAndUpdate(id, dto, { new: true }).exec();
    if (!feature) throw new NotFoundException(`Feature ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: feature.projectId.toString(),
      entity: 'feature',
      action: 'updated',
      entityId: id,
      summary: `Feature "${feature.name}" aktualisiert`,
    });
    return feature;
  }

  async remove(id: string): Promise<void> {
    const result = await this.featureModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Feature ${id} not found`);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId.toString(),
      entity: 'feature',
      action: 'deleted',
      entityId: id,
      summary: `Feature "${result.name}" entfernt`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.featureModel.deleteMany({ projectId }).exec();
  }
}
