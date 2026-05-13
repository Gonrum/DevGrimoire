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

  @Get('customer-links')
  listCustomerLinks() {
    return this.projectsService.listCustomerLinks();
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
