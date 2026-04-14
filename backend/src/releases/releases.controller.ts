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
import { ReleasesService } from './releases.service';
import { CreateReleaseDto } from './dto/create-release.dto';
import { UpdateReleaseDto } from './dto/update-release.dto';
import { ReleaseStatus, ReleasePlatform, ReleaseType } from './schemas/release.schema';
import { ValidateProjectIdPipe } from '../common/pipes/validate-project-id.pipe';

@Controller('releases')
export class ReleasesController {
  constructor(private readonly releasesService: ReleasesService) {}

  @Post()
  @HttpCode(201)
  create(@Body(ValidateProjectIdPipe) dto: CreateReleaseDto) {
    return this.releasesService.create(dto);
  }

  @Get()
  findAll(
    @Query('projectId') projectId: string,
    @Query('status') status?: ReleaseStatus,
    @Query('platform') platform?: ReleasePlatform,
    @Query('releaseType') releaseType?: ReleaseType,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.releasesService.findByProject(
      projectId,
      { status, platform, releaseType },
      limit ? parseInt(limit, 10) : undefined,
      offset ? parseInt(offset, 10) : undefined,
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.releasesService.findById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateReleaseDto) {
    return this.releasesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.releasesService.remove(id);
  }
}
