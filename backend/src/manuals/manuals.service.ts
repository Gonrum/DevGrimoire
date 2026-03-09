import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Manual, ManualDocument } from './schemas/manual.schema';
import { SaveManualDto } from './dto/save-manual.dto';
import { PROJECT_CHANGED } from '../events/project-event';

@Injectable()
export class ManualsService {
  constructor(
    @InjectModel(Manual.name)
    private manualModel: Model<ManualDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async save(dto: SaveManualDto): Promise<ManualDocument> {
    const manual = await this.manualModel.findOneAndUpdate(
      { projectId: dto.projectId },
      { ...dto },
      { new: true, upsert: true },
    ).exec();
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: dto.projectId,
      entity: 'manual',
      action: 'updated',
      entityId: manual._id.toString(),
      summary: 'Handbuch aktualisiert',
    });
    return manual;
  }

  async findByProject(projectId: string): Promise<ManualDocument | null> {
    return this.manualModel.findOne({ projectId }).exec();
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.manualModel.deleteMany({ projectId }).exec();
  }
}
