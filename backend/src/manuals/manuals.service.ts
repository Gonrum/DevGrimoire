import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { Manual, ManualDocument } from './schemas/manual.schema';
import { CreateManualDto } from './dto/create-manual.dto';
import { UpdateManualDto } from './dto/update-manual.dto';
import { CustomersService } from '../customers/customers.service';
import { PROJECT_CHANGED } from '../events/project-event';
import { projectIdFilter } from '../common/project-id-filter';
import { assertSafeCascadeId } from '../common/cascade-guard';
import {
  assertCustomerInScope,
  assertOwnerInScope,
  assertOwnerParamsInScope,
  assertProjectInScope,
  scopeFilter,
} from '../common/scope-guard';

@Injectable()
export class ManualsService {
  constructor(
    @InjectModel(Manual.name)
    private manualModel: Model<ManualDocument>,
    private customersService: CustomersService,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateManualDto): Promise<ManualDocument> {
    if (!dto.projectId && !dto.customerId) {
      throw new BadRequestException('projectId or customerId is required');
    }
    if (dto.projectId && dto.customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    // The create route has no ValidateProjectIdPipe — check both owner params here.
    assertOwnerParamsInScope(dto);
    if (dto.customerId) {
      await this.customersService.findById(dto.customerId);
    }
    const manual = await this.manualModel.create(dto);
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: dto.projectId ?? null,
      customerId: dto.customerId ?? null,
      entity: 'manual',
      action: 'created',
      entityId: manual._id.toString(),
      summary: `Handbuch-Eintrag "${manual.title}" erstellt`,
    });
    return manual;
  }

  async findByProject(projectId: string, category?: string): Promise<ManualDocument[]> {
    assertProjectInScope(projectId);
    const filter: Record<string, unknown> = { projectId: projectIdFilter(projectId) };
    // Relation manuals also carry a customerId that must be in scope.
    Object.assign(filter, scopeFilter());
    if (category) filter.category = category;
    return this.manualModel
      .find(filter)
      .sort({ category: 1, sortOrder: 1, title: 1 })
      .exec();
  }

  async findByCustomer(customerId: string, category?: string): Promise<ManualDocument[]> {
    assertCustomerInScope(customerId);
    const filter: Record<string, unknown> = { customerId: projectIdFilter(customerId) };
    Object.assign(filter, scopeFilter());
    if (category) filter.category = category;
    return this.manualModel
      .find(filter)
      .sort({ category: 1, sortOrder: 1, title: 1 })
      .exec();
  }

  /** Load + 404 + scope check on both axes — every by-id path goes through here before mutating. */
  private async findScoped(id: string): Promise<ManualDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Handbuch-Eintrag nicht gefunden');
    const manual = await this.manualModel.findById(id).exec();
    if (!manual) throw new NotFoundException('Handbuch-Eintrag nicht gefunden');
    assertOwnerInScope({ projectId: manual.projectId, customerId: manual.customerId }, `Manual ${id}`);
    return manual;
  }

  async findById(id: string): Promise<ManualDocument> {
    return this.findScoped(id);
  }

  async update(id: string, dto: UpdateManualDto): Promise<ManualDocument> {
    await this.findScoped(id);
    const manual = await this.manualModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!manual) throw new NotFoundException('Handbuch-Eintrag nicht gefunden');
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: manual.projectId?.toString() ?? null,
      customerId: manual.customerId?.toString() ?? null,
      entity: 'manual',
      action: 'updated',
      entityId: manual._id.toString(),
      summary: `Handbuch-Eintrag "${manual.title}" aktualisiert`,
    });
    return manual;
  }

  async delete(id: string): Promise<void> {
    await this.findScoped(id);
    const manual = await this.manualModel.findByIdAndDelete(id).exec();
    if (!manual) throw new NotFoundException('Handbuch-Eintrag nicht gefunden');
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: manual.projectId?.toString() ?? null,
      customerId: manual.customerId?.toString() ?? null,
      entity: 'manual',
      action: 'deleted',
      entityId: manual._id.toString(),
      summary: `Handbuch-Eintrag "${manual.title}" gelöscht`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    assertSafeCascadeId(projectId, 'projectId');
    await this.manualModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
    assertSafeCascadeId(customerId, 'customerId');
    await this.manualModel.deleteMany({ customerId }).exec();
  }
}
