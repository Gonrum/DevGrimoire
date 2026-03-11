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
  BadRequestException,
} from '@nestjs/common';
import { SchemasService } from './schemas.service';
import { CreateSchemaDto } from './dto/create-schema.dto';
import { UpdateSchemaDto } from './dto/update-schema.dto';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';

@Controller('schemas')
export class SchemasController {
  constructor(private readonly schemasService: SchemasService) {}

  @Post()
  @HttpCode(201)
  create(@Body(ValidateProjectIdPipe) dto: CreateSchemaDto) {
    return this.schemasService.create(dto);
  }

  @Get()
  findByProject(
    @Query('projectId') projectId?: string,
    @Query('dbType') dbType?: string,
    @Query('tags') tags?: string,
  ) {
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }
    const tagArray = tags ? tags.split(',') : undefined;
    return this.schemasService.findByProject(projectId, dbType, tagArray);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.schemasService.findById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSchemaDto) {
    return this.schemasService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.schemasService.remove(id);
  }

  @Get(':id/versions')
  getVersions(@Param('id') id: string) {
    return this.schemasService.getVersions(id);
  }

  @Get(':id/versions/:version')
  getVersion(@Param('id') id: string, @Param('version') version: string) {
    const v = parseInt(version, 10);
    if (isNaN(v)) {
      throw new BadRequestException('version must be a number');
    }
    return this.schemasService.getVersion(id, v);
  }
}
