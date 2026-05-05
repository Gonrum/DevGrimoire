import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { Contact, ContactDocument } from './schemas/contact.schema';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { CustomersService } from '../customers/customers.service';
import { PROJECT_CHANGED } from '../events/project-event';

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
      entity: 'contact',
      action,
      entityId: contact._id.toString(),
      summary: `Kontakt "${contact.name}" ${action === 'created' ? 'angelegt' : action === 'updated' ? 'aktualisiert' : 'entfernt'}`,
    });
  }

  async create(customerId: string, dto: CreateContactDto): Promise<ContactDocument> {
    await this.customersService.findById(customerId);
    const contact = await this.contactModel.create({
      ...dto,
      customerId: this.objectId(customerId, 'customerId'),
    });
    this.emit('created', contact);
    return contact;
  }

  async findByCustomer(customerId: string): Promise<ContactDocument[]> {
    await this.customersService.findById(customerId);
    return this.contactModel
      .find({ customerId: this.objectId(customerId, 'customerId') })
      .sort({ isPrimary: -1, sortOrder: 1, _id: 1 })
      .exec();
  }

  async findById(id: string): Promise<ContactDocument> {
    const contact = await this.contactModel.findById(this.objectId(id, 'contactId')).exec();
    if (!contact) throw new NotFoundException(`Contact ${id} not found`);
    return contact;
  }

  async update(id: string, dto: UpdateContactDto): Promise<ContactDocument> {
    const contact = await this.contactModel
      .findByIdAndUpdate(this.objectId(id, 'contactId'), dto, { new: true })
      .exec();
    if (!contact) throw new NotFoundException(`Contact ${id} not found`);
    this.emit('updated', contact);
    return contact;
  }

  async remove(id: string): Promise<void> {
    const contact = await this.contactModel
      .findByIdAndDelete(this.objectId(id, 'contactId'))
      .exec();
    if (!contact) throw new NotFoundException(`Contact ${id} not found`);
    this.emit('deleted', contact);
  }

  async removeByCustomer(customerId: string): Promise<void> {
    await this.contactModel
      .deleteMany({ customerId: this.objectId(customerId, 'customerId') })
      .exec();
  }
}
