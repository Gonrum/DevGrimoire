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
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateProjectDto) {
    return this.projectsService.create(dto);
  }

  @Get()
  findAll(
    @Query('active') active?: string,
    @Query('favorite') favorite?: string,
    @Query('customerId') customerId?: string,
  ) {
    const activeFilter =
      active !== undefined ? active === 'true' : undefined;
    const favoriteFilter =
      favorite !== undefined ? favorite === 'true' : undefined;
    return this.projectsService.findAll(activeFilter, favoriteFilter, customerId);
  }

  @Get('tags')
  listTags() {
    return this.projectsService.listTags();
  }

  @Post('tags/rename')
  renameTag(@Body() body: { from?: string; to?: string }) {
    if (!body?.from || !body?.to) {
      throw new BadRequestException('from and to are required');
    }
    return this.projectsService.renameTag(body.from, body.to);
  }

  @Post('tags/merge')
  mergeTags(@Body() body: { sources?: string[]; target?: string }) {
    if (!Array.isArray(body?.sources) || body.sources.length === 0 || !body?.target) {
      throw new BadRequestException('sources (non-empty array) and target are required');
    }
    return this.projectsService.mergeTags(body.sources, body.target);
  }

  @Delete('tags/:name')
  deleteTag(@Param('name') name: string) {
    return this.projectsService.deleteTag(name);
  }

  @Get('customer-links')
  listCustomerLinks() {
    return this.projectsService.listCustomerLinks();
  }

  @Get('search')
  search(
    @Query('q') q?: string,
    @Query('customerId') customerId?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? Math.max(1, Math.min(50, parseInt(limit, 10) || 20)) : 20;
    return this.projectsService.searchSemantic(q ?? '', customerId || undefined, parsedLimit);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.projectsService.findById(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProjectDto) {
    return this.projectsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.projectsService.remove(id);
  }
}
