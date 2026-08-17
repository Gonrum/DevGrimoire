import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { Harness, HarnessDocument } from './schemas/harness.schema';
import { CreateHarnessDto } from './dto/create-harness.dto';
import { UpdateHarnessDto } from './dto/update-harness.dto';
import { HarnessScope } from './harness.types';

export interface HarnessOwner {
  scope: HarnessScope;
  projectId?: string;
  customerId?: string;
}

export interface HarnessSummary {
  id: string;
  scope: HarnessScope;
  projectId?: string;
  customerId?: string;
  description?: string;
  enabled: boolean;
  sectionCount: number;
  updatedAt?: Date;
}

@Injectable()
export class HarnessService {
  constructor(
    @InjectModel(Harness.name)
    private harnessModel: Model<HarnessDocument>,
  ) {}

  async create(dto: CreateHarnessDto): Promise<HarnessDocument> {
    return this.harnessModel.create(dto);
  }

  async findById(id: string): Promise<HarnessDocument | null> {
    return this.harnessModel.findById(id).exec();
  }

  async findByOwner(owner: HarnessOwner): Promise<HarnessDocument | null> {
    return this.harnessModel.findOne(this.ownerFilter(owner)).exec();
  }

  async update(id: string, dto: UpdateHarnessDto): Promise<HarnessDocument> {
    const harness = await this.harnessModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true, runValidators: true })
      .exec();
    if (!harness) {
      throw new NotFoundException(`Harness ${id} not found`);
    }
    return harness;
  }

  async remove(id: string): Promise<void> {
    const result = await this.harnessModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`Harness ${id} not found`);
    }
  }

  /** Metadata only — the resolved content is served by `resolve()` (T-438). */
  async list(scope?: HarnessScope): Promise<HarnessSummary[]> {
    const filter: FilterQuery<HarnessDocument> = scope ? { scope } : {};
    const harnesses = await this.harnessModel.find(filter).sort({ scope: 1 }).exec();
    return harnesses.map((harness) => ({
      id: harness._id.toString(),
      scope: harness.scope,
      projectId: harness.projectId?.toString(),
      customerId: harness.customerId?.toString(),
      description: harness.description,
      enabled: harness.enabled,
      sectionCount: harness.sections?.length ?? 0,
      updatedAt: (harness as HarnessDocument & { updatedAt?: Date }).updatedAt,
    }));
  }

  /**
   * Mirrors the DTO rule at the persistence boundary: callers that bypass the
   * controller (MCP handlers, migration script) get the same guarantee.
   */
  private ownerFilter(owner: HarnessOwner): FilterQuery<HarnessDocument> {
    switch (owner.scope) {
      case 'global':
        return { scope: 'global' };
      case 'project':
        if (!owner.projectId) {
          throw new BadRequestException("projectId is required for scope 'project'");
        }
        return { scope: 'project', projectId: owner.projectId };
      case 'customer':
        if (!owner.customerId) {
          throw new BadRequestException("customerId is required for scope 'customer'");
        }
        return { scope: 'customer', customerId: owner.customerId };
      default:
        throw new BadRequestException(`Unknown harness scope '${String(owner.scope)}'`);
    }
  }
}
