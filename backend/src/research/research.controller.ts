import { Controller, Get, Post, Put, Delete, Body, Param, Query, HttpCode, BadRequestException } from '@nestjs/common';
import { ResearchService } from './research.service';
import { CreateResearchDto } from './dto/create-research.dto';
import { UpdateResearchDto } from './dto/update-research.dto';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';

@Controller('research')
export class ResearchController {
  constructor(private readonly researchService: ResearchService) {}

  @Post()
  @HttpCode(201)
  create(@Body(ValidateProjectIdPipe) dto: CreateResearchDto) {
    return this.researchService.create(dto);
  }

  @Get()
  findByOwner(
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
  ) {
    if (!projectId && !customerId) {
      throw new BadRequestException('projectId or customerId query parameter is required');
    }
    if (projectId && customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    return projectId
      ? this.researchService.findByProject(projectId)
      : this.researchService.findByCustomer(customerId!);
  }

  @Get('search')
  search(
    @Query('q') query?: string,
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
  ) {
    if (!query) {
      throw new BadRequestException('q query parameter is required');
    }
    return this.researchService.search(query, projectId, customerId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.researchService.findById(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateResearchDto) {
    return this.researchService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.researchService.remove(id);
  }
}
