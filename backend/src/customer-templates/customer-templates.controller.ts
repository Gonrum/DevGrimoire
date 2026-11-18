import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { CustomerTemplatesService } from './customer-templates.service';
import {
  ApplyCustomerTemplateDto,
  CreateCustomerTemplateDto,
  ListCustomerTemplatesDto,
  UpdateCustomerTemplateDto,
} from './dto/customer-template.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/schemas/user.schema';

@Controller('customer-templates')
export class CustomerTemplatesController {
  constructor(private readonly templates: CustomerTemplatesService) {}

  @Post()
  @Roles(UserRole.ADMIN)
  @HttpCode(201)
  create(@Body() dto: CreateCustomerTemplateDto) {
    return this.templates.create(dto);
  }

  @Get()
  list(@Query() query: ListCustomerTemplatesDto) {
    return this.templates.list(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.templates.findById(id);
  }

  @Put(':id')
  @Roles(UserRole.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateCustomerTemplateDto) {
    return this.templates.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.templates.remove(id);
  }

  @Post(':id/preview')
  preview(@Param('id') id: string, @Body() dto: ApplyCustomerTemplateDto) {
    return this.templates.preview(id, dto.customerId);
  }

  @Post(':id/apply')
  apply(@Param('id') id: string, @Body() dto: ApplyCustomerTemplateDto) {
    return this.templates.apply(id, dto);
  }
}
