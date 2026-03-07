import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';
import { CreateKnowledgeDto } from './dto/create-knowledge.dto';
import { UpdateKnowledgeDto } from './dto/update-knowledge.dto';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';

@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Post()
  @HttpCode(201)
  create(@Body(ValidateProjectIdPipe) dto: CreateKnowledgeDto) {
    return this.knowledgeService.create(dto);
  }

  @Get()
  findByProject(@Query('projectId') projectId?: string) {
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }
    return this.knowledgeService.findByProject(projectId);
  }

  @Get('search')
  search(@Query('q') query?: string, @Query('projectId') projectId?: string) {
    if (!query) {
      throw new BadRequestException('q query parameter is required');
    }
    return this.knowledgeService.search(query, projectId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.knowledgeService.findById(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateKnowledgeDto) {
    return this.knowledgeService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.knowledgeService.remove(id);
  }
}
