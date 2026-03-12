import { Controller, Get, Post, Put, Delete, Body, Param, Query, BadRequestException } from '@nestjs/common';
import { ManualsService } from './manuals.service';
import { CreateManualDto } from './dto/create-manual.dto';
import { UpdateManualDto } from './dto/update-manual.dto';

@Controller('manuals')
export class ManualsController {
  constructor(private readonly manualsService: ManualsService) {}

  @Get()
  findByProject(
    @Query('projectId') projectId?: string,
    @Query('category') category?: string,
  ) {
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }
    return this.manualsService.findByProject(projectId, category);
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.manualsService.findById(id);
  }

  @Post()
  create(@Body() dto: CreateManualDto) {
    return this.manualsService.create(dto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateManualDto) {
    return this.manualsService.update(id, dto);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.manualsService.delete(id);
  }
}
