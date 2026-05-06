import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { EnvironmentsService } from './environments.service';
import { CreateEnvironmentDto } from './dto/create-environment.dto';
import { UpdateEnvironmentDto } from './dto/update-environment.dto';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';

@Controller('environments')
export class EnvironmentsController {
  constructor(private readonly environmentsService: EnvironmentsService) {}

  @Post()
  create(@Body(ValidateProjectIdPipe) dto: CreateEnvironmentDto) {
    return this.environmentsService.create(dto);
  }

  @Get()
  findByProject(
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
  ) {
    if (!projectId && !customerId) {
      throw new BadRequestException('projectId or customerId query parameter is required');
    }
    if (projectId && customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    return customerId
      ? this.environmentsService.findByCustomer(customerId)
      : this.environmentsService.findByProject(projectId!);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.environmentsService.findById(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateEnvironmentDto) {
    return this.environmentsService.update(id, dto);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.environmentsService.delete(id);
  }
}
