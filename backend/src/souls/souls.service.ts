import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { Soul, SoulDocument } from './schemas/soul.schema';
import { UpdateSoulDto } from './dto/update-soul.dto';
import { PROJECT_CHANGED } from '../events/project-event';

interface SoulOwner {
  projectId?: string;
  customerId?: string;
}

@Injectable()
export class SoulsService {
  constructor(
    @InjectModel(Soul.name)
    private soulModel: Model<SoulDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async upsert(owner: SoulOwner, dto: UpdateSoulDto): Promise<SoulDocument> {
    const filter = this.ownerFilter(owner);

    const $set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) {
        $set[key] = value;
      }
    }

    const soul = await this.soulModel
      .findOneAndUpdate(
        filter,
        { $set, $setOnInsert: filter },
        { upsert: true, new: true },
      )
      .exec();

    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: owner.projectId || null,
      customerId: owner.customerId || null,
      entity: 'soul',
      action: 'updated',
      entityId: soul._id.toString(),
      summary: owner.customerId ? 'Customer soul updated' : 'Soul aktualisiert',
    });

    return soul;
  }

  async findByOwner(owner: SoulOwner): Promise<SoulDocument | null> {
    return this.soulModel.findOne(this.ownerFilter(owner)).exec();
  }

  async findByProject(projectId: string): Promise<SoulDocument | null> {
    return this.findByOwner({ projectId });
  }

  async findByCustomer(customerId: string): Promise<SoulDocument | null> {
    return this.findByOwner({ customerId });
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.soulModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
    await this.soulModel.deleteMany({ customerId }).exec();
  }

  private ownerFilter(owner: SoulOwner): { projectId?: string; customerId?: string } {
    if (!owner.projectId && !owner.customerId) {
      throw new BadRequestException('projectId or customerId is required');
    }
    if (owner.projectId && owner.customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    return owner.projectId ? { projectId: owner.projectId } : { customerId: owner.customerId };
  }
}
