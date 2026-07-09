import { Controller, Get, Put, Post, UseGuards, Query, Body, BadRequestException, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WebSearchService } from './services/web-search.service';
import { WebSearchConfigService } from './services/web-search-config.service';
import { ReadabilityService } from './services/readability.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../auth/schemas/user.schema';
import { SearchCategory, SearchTimeRange } from './dto/web-search.dto';
import {
  SearchProviderType,
  SEARCH_PROVIDER_TYPES,
  UpdateWebSearchConfigDto,
  TestProviderConfigDto,
} from './dto/web-search-config.dto';

@Controller('web-search')
export class WebSearchController {
  constructor(
    private readonly webSearchService: WebSearchService,
    private readonly readabilityService: ReadabilityService,
    private readonly configService: WebSearchConfigService,
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
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async search(
    @Query('q') q: string,
    @Query('language') language?: string,
    @Query('categories') categories?: string,
    @Query('timeRange') timeRange?: SearchTimeRange,
    @Query('limit') limit?: string,
    @Query('provider') provider?: string,
  ) {
    if (!q) throw new BadRequestException('Query parameter "q" is required');
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    const parsedCategories = categories
      ? (categories.split(',').map((c) => c.trim()).filter(Boolean) as SearchCategory[])
      : undefined;
    const parsedProvider = provider && (SEARCH_PROVIDER_TYPES as readonly string[]).includes(provider)
      ? (provider as SearchProviderType)
      : undefined;
    return this.webSearchService.search({
      query: q,
      language,
      categories: parsedCategories,
      timeRange,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      provider: parsedProvider,
    });
  }

  // ---------- Provider configuration ----------

  @Get('config')
  async getConfig() {
    return this.configService.getConfig();
  }

  @Put('config')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async setConfig(@Body() dto: UpdateWebSearchConfigDto) {
    return this.configService.setConfig(dto);
  }

  @Post('config/test')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async testConfig(@Body() dto: TestProviderConfigDto) {
    return this.configService.testProvider(dto);
  }

  @Post('fetch')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async fetch(@Body() body: { url: string; raw?: boolean; maxLength?: number }) {
    if (!body?.url) throw new BadRequestException('Field "url" is required');
    return this.readabilityService.fetch({
      url: body.url,
      raw: body.raw,
      maxLength: body.maxLength,
    });
  }
}
