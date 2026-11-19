import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { Contact, ContactDocument } from './schemas/contact.schema';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { CustomersService } from '../customers/customers.service';
import { PROJECT_CHANGED } from '../events/project-event';
import { assertSafeCascadeId } from '../common/cascade-guard';
import { assertOwnerInScope, assertOwnerPermission } from '../common/scope-guard';

@Injectable()
export class ContactsService {
  constructor(
    @InjectModel(Contact.name) private contactModel: Model<ContactDocument>,
    private readonly customersService: CustomersService,
    private eventEmitter: EventEmitter2,
  ) {}

  private objectId(id: string, label = 'id'): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Invalid ${label}`);
    }
    return new Types.ObjectId(id);
  }

  private emit(action: 'created' | 'updated' | 'deleted', contact: ContactDocument): void {
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: null,
      customerId: contact.customerId?.toString() || null,
      entity: 'contact',
      action,
      entityId: contact._id.toString(),
      summary: `Kontakt "${contact.name}" ${action === 'created' ? 'angelegt' : action === 'updated' ? 'aktualisiert' : 'entfernt'}`,
    });
  }

  async create(customerId: string, dto: CreateContactDto): Promise<ContactDocument> {
    await this.customersService.findById(customerId);
    assertOwnerPermission({ customerId }, 'contact', 'write');
    const contact = await this.contactModel.create({
      ...dto,
      customerId: this.objectId(customerId, 'customerId'),
    });
    this.emit('created', contact);
    return contact;
  }

  async findByCustomer(customerId: string): Promise<ContactDocument[]> {
    await this.customersService.findById(customerId);
    assertOwnerPermission({ customerId }, 'contact', 'read');
    return this.contactModel
      .find({ customerId: this.objectId(customerId, 'customerId') })
      .sort({ isPrimary: -1, sortOrder: 1, _id: 1 })
      .exec();
  }

  /**
   * Load + 404 + customer-scope check. Every by-id path goes through here —
   * before, a narrowed actor could read, overwrite and delete contacts of
   * foreign customers by contactId alone. `expectedCustomerId` (the route's
   * `:customerId`) must match too, so a contact cannot be addressed through
   * an unrelated customer URL; a mismatch is reported as 404.
   */
  private async findScoped(
    id: string,
    expectedCustomerId?: string,
    action: 'read' | 'write' = 'read',
  ): Promise<ContactDocument> {
    const contact = await this.contactModel.findById(this.objectId(id, 'contactId')).exec();
    if (!contact) throw new NotFoundException(`Contact ${id} not found`);
    assertOwnerInScope({ customerId: contact.customerId }, `Contact ${id}`);
    assertOwnerPermission({ customerId: contact.customerId }, 'contact', action);
    if (expectedCustomerId !== undefined && contact.customerId?.toString() !== expectedCustomerId) {
      throw new NotFoundException(`Contact ${id} not found`);
    }
    return contact;
  }

  async findById(id: string, expectedCustomerId?: string): Promise<ContactDocument> {
    return this.findScoped(id, expectedCustomerId);
  }

  async update(id: string, dto: UpdateContactDto, expectedCustomerId?: string): Promise<ContactDocument> {
    // Check BEFORE writing; findByIdAndUpdate would already have mutated.
    await this.findScoped(id, expectedCustomerId, 'write');
    const contact = await this.contactModel
      .findByIdAndUpdate(this.objectId(id, 'contactId'), dto, { new: true })
      .exec();
    if (!contact) throw new NotFoundException(`Contact ${id} not found`);
    this.emit('updated', contact);
    return contact;
  }

  async remove(id: string, expectedCustomerId?: string): Promise<void> {
    await this.findScoped(id, expectedCustomerId, 'write');
    const contact = await this.contactModel
      .findByIdAndDelete(this.objectId(id, 'contactId'))
      .exec();
    if (!contact) throw new NotFoundException(`Contact ${id} not found`);
    this.emit('deleted', contact);
  }

  async removeByCustomer(customerId: string): Promise<void> {
    assertSafeCascadeId(customerId, 'customerId');
    await this.contactModel
      .deleteMany({ customerId: this.objectId(customerId, 'customerId') })
      .exec();
  }
}
