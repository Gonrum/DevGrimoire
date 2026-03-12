import { Controller, Get, Put, Body, Query, BadRequestException } from '@nestjs/common';
import { SoulsService } from './souls.service';
import { CreateSoulDto } from './dto/create-soul.dto';

@Controller('souls')
export class SoulsController {
  constructor(private readonly soulsService: SoulsService) {}

  @Get()
  async findByProject(@Query('projectId') projectId?: string) {
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }
    const soul = await this.soulsService.findByProject(projectId);
    return soul || {};
  }

  @Put()
  upsert(@Body() dto: CreateSoulDto) {
    const { projectId, ...fields } = dto;
    return this.soulsService.upsert(projectId, fields);
  }
}
