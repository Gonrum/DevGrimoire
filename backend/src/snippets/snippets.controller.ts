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
import { SnippetsService } from './snippets.service';
import { CreateSnippetDto } from './dto/create-snippet.dto';
import { UpdateSnippetDto } from './dto/update-snippet.dto';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';

@Controller('snippets')
export class SnippetsController {
  constructor(private readonly snippetsService: SnippetsService) {}

  @Post()
  @HttpCode(201)
  create(@Body(ValidateProjectIdPipe) dto: CreateSnippetDto) {
    return this.snippetsService.create(dto);
  }

  @Get()
  findByProject(
    @Query('projectId') projectId?: string,
    @Query('language') language?: string,
    @Query('category') category?: string,
    @Query('tag') tag?: string,
  ) {
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }
    return this.snippetsService.findByProject(projectId, language, category, tag);
  }

  @Get('search')
  search(@Query('q') query?: string, @Query('projectId') projectId?: string) {
    if (!query) {
      throw new BadRequestException('q query parameter is required');
    }
    return this.snippetsService.search(query, projectId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.snippetsService.findById(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSnippetDto) {
    return this.snippetsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.snippetsService.remove(id);
  }
}
