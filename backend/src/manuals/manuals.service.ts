import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Manual, ManualDocument } from './schemas/manual.schema';
import { CreateManualDto } from './dto/create-manual.dto';
import { UpdateManualDto } from './dto/update-manual.dto';
import { PROJECT_CHANGED } from '../events/project-event';

@Injectable()
export class ManualsService {
  constructor(
    @InjectModel(Manual.name)
    private manualModel: Model<ManualDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateManualDto): Promise<ManualDocument> {
    const manual = await this.manualModel.create(dto);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: dto.projectId,
      entity: 'manual',
      action: 'created',
      entityId: manual._id.toString(),
      summary: `Handbuch-Eintrag "${manual.title}" erstellt`,
    });
    return manual;
  }

  async findByProject(projectId: string, category?: string): Promise<ManualDocument[]> {
    const filter: Record<string, unknown> = { projectId };
    if (category) filter.category = category;
    return this.manualModel
      .find(filter)
      .sort({ category: 1, sortOrder: 1, title: 1 })
      .exec();
  }

  async findById(id: string): Promise<ManualDocument> {
    const manual = await this.manualModel.findById(id).exec();
    if (!manual) throw new NotFoundException('Handbuch-Eintrag nicht gefunden');
    return manual;
  }

  async update(id: string, dto: UpdateManualDto): Promise<ManualDocument> {
    const manual = await this.manualModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!manual) throw new NotFoundException('Handbuch-Eintrag nicht gefunden');
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: manual.projectId.toString(),
      entity: 'manual',
      action: 'updated',
      entityId: manual._id.toString(),
      summary: `Handbuch-Eintrag "${manual.title}" aktualisiert`,
    });
    return manual;
  }

  async delete(id: string): Promise<void> {
    const manual = await this.manualModel.findByIdAndDelete(id).exec();
    if (!manual) throw new NotFoundException('Handbuch-Eintrag nicht gefunden');
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: manual.projectId.toString(),
      entity: 'manual',
      action: 'deleted',
      entityId: manual._id.toString(),
      summary: `Handbuch-Eintrag "${manual.title}" gelöscht`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.manualModel.deleteMany({ projectId }).exec();
  }
}
