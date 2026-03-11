import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
} from '@nestjs/common';
import { DependenciesService } from './dependencies.service';
import { CreateDependencyDto } from './dto/create-dependency.dto';
import { UpdateDependencyDto } from './dto/update-dependency.dto';
import { BulkCreateDependencyDto } from './dto/bulk-create-dependency.dto';
import { PackageManager } from './schemas/dependency.schema';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';

@Controller('dependencies')
export class DependenciesController {
  constructor(private readonly dependenciesService: DependenciesService) {}

  @Post()
  @HttpCode(201)
  create(@Body(ValidateProjectIdPipe) dto: CreateDependencyDto) {
    return this.dependenciesService.create(dto);
  }

  @Post('bulk')
  @HttpCode(200)
  bulkCreate(@Body(ValidateProjectIdPipe) dto: BulkCreateDependencyDto) {
    return this.dependenciesService.bulkCreate(dto);
  }

  @Get()
  findAll(
    @Query('projectId') projectId: string,
    @Query('packageManager') packageManager?: PackageManager,
    @Query('category') category?: string,
    @Query('devDependency') devDependency?: string,
  ) {
    return this.dependenciesService.findByProject(projectId, {
      packageManager,
      category,
      devDependency: devDependency !== undefined ? devDependency === 'true' : undefined,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.dependenciesService.findById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDependencyDto) {
    return this.dependenciesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.dependenciesService.remove(id);
  }
}
