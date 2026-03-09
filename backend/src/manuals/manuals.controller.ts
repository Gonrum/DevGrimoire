import { Controller, Get, Put, Body, Query, BadRequestException } from '@nestjs/common';
import { ManualsService } from './manuals.service';
import { SaveManualDto } from './dto/save-manual.dto';

@Controller('manuals')
export class ManualsController {
  constructor(private readonly manualsService: ManualsService) {}

  @Get()
  findByProject(@Query('projectId') projectId?: string) {
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }
    return this.manualsService.findByProject(projectId);
  }

  @Put()
  save(@Body() dto: SaveManualDto) {
    return this.manualsService.save(dto);
  }
}
