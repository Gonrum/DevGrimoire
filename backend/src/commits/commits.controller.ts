import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { CommitsService } from './commits.service';
import { SyncDto } from './dto/sync.dto';
import { ValidateTokenDto } from './dto/validate-token.dto';

@Controller('commits')
export class CommitsController {
  constructor(private readonly commitsService: CommitsService) {}

  @Get()
  findByProject(
    @Query('projectId') projectId?: string,
    @Query('branch') branch?: string,
    @Query('author') author?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('provider') provider?: string,
    @Query('repoLabel') repoLabel?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }
    return this.commitsService.findByProject(projectId, {
      branch,
      author,
      since,
      until,
      provider,
      repoLabel,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get('search')
  search(
    @Query('q') query?: string,
    @Query('projectId') projectId?: string,
    @Query('limit') limit?: string,
  ) {
    if (!query) {
      throw new BadRequestException('q query parameter is required');
    }
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }
    return this.commitsService.search(projectId, query, limit ? Math.min(parseInt(limit, 10), 100) : undefined);
  }

  @Get('count')
  count(
    @Query('projectId') projectId?: string,
    @Query('repoLabel') repoLabel?: string,
  ) {
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }
    return this.commitsService.countByProject(projectId, repoLabel).then((count) => ({ count }));
  }

  @Get('branches')
  async branches(
    @Query('projectId') projectId?: string,
    @Query('repoIndex') repoIndex?: string,
  ) {
    if (!projectId) throw new BadRequestException('projectId is required');
    if (repoIndex === undefined) throw new BadRequestException('repoIndex is required');
    return this.commitsService.fetchBranches(projectId, parseInt(repoIndex, 10));
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.commitsService.findById(id);
  }

  @Post('sync')
  @HttpCode(200)
  async sync(@Body() dto: SyncDto) {
    if (dto.repoIndex !== undefined) {
      return this.commitsService.syncRepository(dto.projectId, dto.repoIndex);
    }
    return this.commitsService.syncAllForProject(dto.projectId);
  }

  @Post('validate-token')
  @HttpCode(200)
  async validateToken(@Body() dto: ValidateTokenDto) {
    const config = {
      provider: dto.provider as 'github' | 'gitlab',
      label: '',
      baseUrl: dto.baseUrl || '',
      owner: dto.owner || '',
      repo: dto.repo || '',
      gitlabProjectId: dto.gitlabProjectId || '',
      defaultBranch: 'main',
      syncEnabled: true,
    };
    const valid = await this.commitsService.validateRepoToken(config, dto.token);
    return { valid };
  }
}
