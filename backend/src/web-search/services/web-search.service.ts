import { Injectable, Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'crypto';
import { AxiosError } from 'axios';
import { SettingsService } from '../../settings/settings.service';
import { WebSearchRateLimiterService } from './web-search-rate-limiter.service';
import { WebSearchCache, WebSearchCacheDocument } from '../schemas/web-search-cache.schema';
import {
  WebSearchQuery,
  WebSearchResponse,
  WebSearchHit,
  SearxngResponse,
  SearchCategory,
} from '../dto/web-search.dto';

export const SETTING_ENABLED = 'web_search_enabled';
export const SETTING_SEARXNG_URL = 'web_search_searxng_url';
export const SETTING_DEFAULT_LANG = 'web_search_default_language';
export const SETTING_CACHE_TTL_HOURS = 'web_search_cache_ttl_hours';
export const SETTING_CONTENT_CACHE_TTL_DAYS = 'web_search_content_cache_ttl_days';
export const SETTING_MAX_RESULTS = 'web_search_max_results';

const VALID_CATEGORIES: ReadonlySet<SearchCategory> = new Set([
  'general',
  'news',
  'science',
  'it',
  'files',
]);

@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);
  private readonly envUrl = process.env.SEARXNG_URL || 'http://searxng:8080';

  constructor(
    private readonly http: HttpService,
    private readonly settings: SettingsService,
    private readonly rateLimiter: WebSearchRateLimiterService,
    @InjectModel(WebSearchCache.name)
    private readonly cacheModel: Model<WebSearchCacheDocument>,
  ) {}

  async isEnabled(): Promise<boolean> {
    const value = await this.settings.getOrDefault(SETTING_ENABLED, 'true');
    return value.toLowerCase() === 'true';
  }

  async getSearxngUrl(): Promise<string> {
    const value = await this.settings.getOrDefault(SETTING_SEARXNG_URL, this.envUrl);
    return value.replace(/\/$/, '');
  }

  async getDefaultLanguage(): Promise<string> {
    return this.settings.getOrDefault(SETTING_DEFAULT_LANG, 'de');
  }

  async getMaxResults(): Promise<number> {
    const raw = await this.settings.getOrDefault(SETTING_MAX_RESULTS, '10');
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 10;
  }

  async getCacheTtlHours(): Promise<number> {
    const raw = await this.settings.getOrDefault(SETTING_CACHE_TTL_HOURS, '24');
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 24;
  }

  async getContentCacheTtlDays(): Promise<number> {
    const raw = await this.settings.getOrDefault(SETTING_CONTENT_CACHE_TTL_DAYS, '7');
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 7;
  }

  /** SearXNG health probe. */
  async ping(): Promise<{ ok: boolean; url: string; error?: string }> {
    const url = await this.getSearxngUrl();
    try {
      const res = await this.http.axiosRef.get(`${url}/healthz`, { timeout: 3000 });
      return { ok: res.status === 200, url };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, url, error: msg };
    }
  }

  async search(input: WebSearchQuery): Promise<WebSearchResponse> {
    if (!(await this.isEnabled())) {
      throw new BadRequestException('Web search is disabled');
    }

    const query = (input.query ?? '').trim();
    if (!query) {
      throw new BadRequestException('Query must not be empty');
    }

    const language = (input.language ?? (await this.getDefaultLanguage())).slice(0, 5);
    const categories = (input.categories ?? []).filter((c) => VALID_CATEGORIES.has(c));
    const limit = Math.min(Math.max(input.limit ?? (await this.getMaxResults()), 1), 20);
    const timeRange = input.timeRange;

    const hash = this.hashQuery(query, language, categories, timeRange);

    const cached = await this.cacheModel.findOne({ queryHash: hash }).lean().exec();
    if (cached) {
      return { ...(cached.payload as unknown as WebSearchResponse), cached: true };
    }

    // Rate-limit only on cache miss — cached responses are free.
    this.rateLimiter.consume('search');

    const url = await this.getSearxngUrl();
    const params: Record<string, string> = {
      q: query,
      format: 'json',
      language,
      safesearch: '1',
    };
    if (categories.length) params.categories = categories.join(',');
    if (timeRange) params.time_range = timeRange;

    const raw = await this.callSearxng(url, params);

    const hits: WebSearchHit[] = (raw.results ?? [])
      .slice(0, limit)
      .map((r) => ({
        title: r.title ?? '',
        url: r.url,
        snippet: (r.content ?? '').slice(0, 500),
        engine: r.engine,
        score: r.score,
        publishedDate: r.publishedDate,
      }));

    const response: WebSearchResponse = {
      results: hits,
      totalResults: raw.number_of_results ?? hits.length,
      cached: false,
      query,
      engines: raw.engines ?? [],
    };

    // Fire and forget — cache write must not block response
    this.writeCache(hash, query, response).catch((err) =>
      this.logger.warn(`cache write failed: ${err.message ?? err}`),
    );

    return response;
  }

  private async writeCache(hash: string, query: string, payload: WebSearchResponse): Promise<void> {
    const ttlHours = await this.getCacheTtlHours();
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
    const cacheable = { ...payload, cached: false };
    await this.cacheModel.updateOne(
      { queryHash: hash },
      { $set: { queryHash: hash, query, payload: cacheable, expiresAt } },
      { upsert: true },
    );
  }

  private async callSearxng(url: string, params: Record<string, string>): Promise<SearxngResponse> {
    try {
      const res = await this.http.axiosRef.get<SearxngResponse>(`${url}/search`, {
        params,
        timeout: 15000,
        headers: { Accept: 'application/json' },
      });
      return res.data;
    } catch (err) {
      const ax = err as AxiosError;
      const msg = ax.response
        ? `SearXNG returned ${ax.response.status}`
        : ax.code === 'ECONNABORTED'
          ? 'SearXNG timeout'
          : `SearXNG unreachable: ${ax.message}`;
      this.logger.error(msg);
      throw new ServiceUnavailableException(msg);
    }
  }

  async stats(): Promise<{ cached: number; oldestEntry?: Date }> {
    const [count, oldest] = await Promise.all([
      this.cacheModel.countDocuments().exec(),
      this.cacheModel.findOne().sort({ createdAt: 1 }).lean<{ createdAt?: Date }>().exec(),
    ]);
    return { cached: count, oldestEntry: oldest?.createdAt };
  }

  async clearCache(): Promise<{ deleted: number }> {
    const res = await this.cacheModel.deleteMany({}).exec();
    return { deleted: res.deletedCount ?? 0 };
  }

  private hashQuery(query: string, language: string, categories: SearchCategory[], timeRange?: string): string {
    const normalized = [
      query.toLowerCase().trim(),
      language,
      [...categories].sort().join(','),
      timeRange ?? '',
    ].join('|');
    return createHash('sha256').update(normalized).digest('hex');
  }
}
