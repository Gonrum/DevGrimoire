import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { PermissionGate } from '../auth/decorators/permission-gate.decorator';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import {
  CreateCustomerProjectLinkDto,
  UpdateCustomerProjectLinkDto,
} from './dto/customer-project-link.dto';
import { CustomerStatus } from './schemas/customer.schema';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  // Checked precisely in the service (project/customer write, delete, archive).
  @PermissionGate('service')
  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateCustomerDto) {
    return this.customersService.create(dto);
  }

  @Get()
  findAll(
    @Query('status') status?: CustomerStatus,
    @Query('tag') tag?: string,
    @Query('q') q?: string,
    @Query('includeArchived') includeArchived?: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.customersService.findAll({
      status,
      tag,
      q,
      includeArchived: includeArchived === 'true',
      projectId,
    });
  }

  @Get('by-project/:projectId/links')
  findLinksByProject(@Param('projectId') projectId: string) {
    return this.customersService.findLinksByProject(projectId);
  }

  @Get('dashboard')
  getDashboard() {
    return this.customersService.getDashboard();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.customersService.findById(id);
  }

  // Checked precisely in the service (project/customer write, delete, archive).
  @PermissionGate('service')
  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.customersService.update(id, dto);
  }

  // Checked precisely in the service (project/customer write, delete, archive).
  @PermissionGate('service')
  @Delete(':id')
  archive(@Param('id') id: string) {
    return this.customersService.archive(id);
  }

  @Post(':id/project-links')
  @HttpCode(201)
  createProjectLink(
    @Param('id') id: string,
    @Body() dto: CreateCustomerProjectLinkDto,
  ) {
    return this.customersService.createProjectLink(id, dto);
  }

  @Get(':id/project-links')
  findProjectLinks(@Param('id') id: string) {
    return this.customersService.findProjectLinks(id);
  }

  @Put(':id/project-links/:linkId')
  updateProjectLink(
    @Param('id') id: string,
    @Param('linkId') linkId: string,
    @Body() dto: UpdateCustomerProjectLinkDto,
  ) {
    return this.customersService.updateProjectLink(id, linkId, dto);
  }

  @Delete(':id/project-links/:linkId')
  @HttpCode(204)
  deleteProjectLink(@Param('id') id: string, @Param('linkId') linkId: string) {
    return this.customersService.deleteProjectLink(id, linkId);
  }
}
