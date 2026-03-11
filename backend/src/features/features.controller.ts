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
import { FeaturesService } from './features.service';
import { CreateFeatureDto } from './dto/create-feature.dto';
import { UpdateFeatureDto } from './dto/update-feature.dto';
import { FeatureStatus } from './schemas/feature.schema';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';

@Controller('features')
export class FeaturesController {
  constructor(private readonly featuresService: FeaturesService) {}

  @Post()
  @HttpCode(201)
  create(@Body(ValidateProjectIdPipe) dto: CreateFeatureDto) {
    return this.featuresService.create(dto);
  }

  @Get()
  findAll(
    @Query('projectId') projectId: string,
    @Query('status') status?: FeatureStatus,
    @Query('category') category?: string,
  ) {
    return this.featuresService.findByProject(projectId, { status, category });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.featuresService.findById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateFeatureDto) {
    return this.featuresService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.featuresService.remove(id);
  }
}
