import { Controller, Get, Put, Body, Query, BadRequestException } from '@nestjs/common';
import { SoulsService } from './souls.service';
import { CreateSoulDto } from './dto/create-soul.dto';

@Controller('souls')
export class SoulsController {
  constructor(private readonly soulsService: SoulsService) {}

  @Get()
  async findByOwner(
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
  ) {
    if (!projectId && !customerId) {
      throw new BadRequestException('projectId or customerId query parameter is required');
    }
    if (projectId && customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    const soul = await this.soulsService.findByOwner({ projectId, customerId });
    return soul || {};
  }

  @Put()
  upsert(@Body() dto: CreateSoulDto) {
    const { projectId, customerId, ...fields } = dto;
    return this.soulsService.upsert({ projectId, customerId }, fields);
  }
}
