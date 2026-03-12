import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Soul, SoulDocument } from './schemas/soul.schema';
import { UpdateSoulDto } from './dto/update-soul.dto';
import { PROJECT_CHANGED } from '../events/project-event';

@Injectable()
export class SoulsService {
  constructor(
    @InjectModel(Soul.name)
    private soulModel: Model<SoulDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async upsert(projectId: string, dto: UpdateSoulDto): Promise<SoulDocument> {
    const $set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) {
        $set[key] = value;
      }
    }

    const soul = await this.soulModel
      .findOneAndUpdate(
        { projectId },
        { $set, $setOnInsert: { projectId } },
        { upsert: true, new: true },
      )
      .exec();

    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId,
      entity: 'soul',
      action: 'updated',
      entityId: soul._id.toString(),
      summary: 'Soul aktualisiert',
    });

    return soul;
  }

  async findByProject(projectId: string): Promise<SoulDocument | null> {
    return this.soulModel.findOne({ projectId }).exec();
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.soulModel.deleteMany({ projectId }).exec();
  }
}
