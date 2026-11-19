import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { PermissionGate } from '../auth/decorators/permission-gate.decorator';
import { ContactsService } from './contacts.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';

// Writes here are checked against the precise catalog permission in the
// service (see `common/permissions.ts`), not by the generic entry gate.
@PermissionGate('service')
@Controller('customers/:customerId/contacts')
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Post()
  @HttpCode(201)
  create(@Param('customerId') customerId: string, @Body() dto: CreateContactDto) {
    return this.contactsService.create(customerId, dto);
  }

  @Get()
  list(@Param('customerId') customerId: string) {
    return this.contactsService.findByCustomer(customerId);
  }

  @Get(':contactId')
  get(@Param('customerId') customerId: string, @Param('contactId') contactId: string) {
    return this.contactsService.findById(contactId, customerId);
  }

  @Put(':contactId')
  update(
    @Param('customerId') customerId: string,
    @Param('contactId') contactId: string,
    @Body() dto: UpdateContactDto,
  ) {
    return this.contactsService.update(contactId, dto, customerId);
  }

  @Delete(':contactId')
  @HttpCode(204)
  remove(@Param('customerId') customerId: string, @Param('contactId') contactId: string) {
    return this.contactsService.remove(contactId, customerId);
  }
}
