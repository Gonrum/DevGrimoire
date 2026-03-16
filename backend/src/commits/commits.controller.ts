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
      limit: limit ? parseInt(limit, 10) : undefined,
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
    return this.commitsService.search(projectId, query, limit ? parseInt(limit, 10) : undefined);
  }

  @Get('count')
  count(@Query('projectId') projectId?: string) {
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }
    return this.commitsService.countByProject(projectId).then((count) => ({ count }));
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.commitsService.findById(id);
  }

  @Post('sync')
  @HttpCode(200)
  async sync(@Body() body: { projectId: string; repoIndex?: number }) {
    if (!body.projectId) {
      throw new BadRequestException('projectId is required');
    }
    if (body.repoIndex !== undefined) {
      return this.commitsService.syncRepository(body.projectId, body.repoIndex);
    }
    return this.commitsService.syncAllForProject(body.projectId);
  }

  @Post('validate-token')
  @HttpCode(200)
  async validateToken(
    @Body() body: { provider: string; baseUrl?: string; owner?: string; repo?: string; gitlabProjectId?: string; token: string },
  ) {
    const config = {
      provider: body.provider as 'github' | 'gitlab',
      baseUrl: body.baseUrl || '',
      owner: body.owner || '',
      repo: body.repo || '',
      gitlabProjectId: body.gitlabProjectId || '',
      defaultBranch: 'main',
      syncEnabled: true,
    };
    const valid = await this.commitsService.validateRepoToken(config, body.token);
    return { valid };
  }
}
