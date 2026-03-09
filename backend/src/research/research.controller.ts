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
  findByProject(@Query('projectId') projectId?: string) {
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }
    return this.researchService.findByProject(projectId);
  }

  @Get('search')
  search(@Query('q') query?: string, @Query('projectId') projectId?: string) {
    if (!query) {
      throw new BadRequestException('q query parameter is required');
    }
    return this.researchService.search(query, projectId);
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
