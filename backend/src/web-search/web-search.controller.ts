import { Controller, Get, Post, UseGuards, Query, Body, BadRequestException } from '@nestjs/common';
import { WebSearchService } from './services/web-search.service';
import { ReadabilityService } from './services/readability.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../auth/schemas/user.schema';
import { SearchCategory, SearchTimeRange } from './dto/web-search.dto';

@Controller('web-search')
export class WebSearchController {
  constructor(
    private readonly webSearchService: WebSearchService,
    private readonly readabilityService: ReadabilityService,
  ) {}

  @Get('health')
  async health() {
    const enabled = await this.webSearchService.isEnabled();
    const ping = await this.webSearchService.ping();
    return { enabled, searxng: ping };
  }

  @Get('stats')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async stats() {
    const [searchStats, fetchStats] = await Promise.all([
      this.webSearchService.stats(),
      this.readabilityService.stats(),
    ]);
    return { search: searchStats, fetch: fetchStats };
  }

  @Post('cache/clear')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async clearCache() {
    const [search, fetch] = await Promise.all([
      this.webSearchService.clearCache(),
      this.readabilityService.clearCache(),
    ]);
    return { search, fetch };
  }

  @Get('search')
  async search(
    @Query('q') q: string,
    @Query('language') language?: string,
    @Query('categories') categories?: string,
    @Query('timeRange') timeRange?: SearchTimeRange,
    @Query('limit') limit?: string,
  ) {
    if (!q) throw new BadRequestException('Query parameter "q" is required');
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    const parsedCategories = categories
      ? (categories.split(',').map((c) => c.trim()).filter(Boolean) as SearchCategory[])
      : undefined;
    return this.webSearchService.search({
      query: q,
      language,
      categories: parsedCategories,
      timeRange,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
  }

  @Post('fetch')
  async fetch(@Body() body: { url: string; raw?: boolean; maxLength?: number }) {
    if (!body?.url) throw new BadRequestException('Field "url" is required');
    return this.readabilityService.fetch({
      url: body.url,
      raw: body.raw,
      maxLength: body.maxLength,
    });
  }
}
