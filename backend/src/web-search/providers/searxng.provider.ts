import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { SearchProvider, SearchProviderOptions, SearchResult } from './search-provider.interface';
import { providerErrorMessage } from './provider-error';
import { SearxngResponse } from '../dto/web-search.dto';

/**
 * SearXNG-backed SearchProvider adapter.
 *
 * Extracted from `WebSearchService` (formerly `callSearxng`) — behavior-preserving
 * refactor. The URL is resolved lazily via `getUrl` (injected as a closure) so this
 * class has no dependency on `WebSearchService` or `SettingsService`, avoiding a
 * circular dependency between the two.
 */
@Injectable()
export class SearxngProvider implements SearchProvider {
  readonly id = 'searxng';
  private readonly logger = new Logger(SearxngProvider.name);

  constructor(
    private readonly http: HttpService,
    private readonly getUrl: () => Promise<string>,
  ) {}

  async search(query: string, opts: SearchProviderOptions): Promise<SearchResult[]> {
    const params: Record<string, string> = {
      q: query,
      format: 'json',
      safesearch: '1',
    };
    if (opts.language) params.language = opts.language;
    if (opts.categories) params.categories = opts.categories;
    if (opts.timeRange) params.time_range = opts.timeRange;

    const url = await this.getUrl();
    const raw = await this.callSearxng(url, params);

    const results = raw.results ?? [];
    const limit = opts.limit ?? results.length;

    return results.slice(0, limit).map((r) => ({
      title: r.title ?? '',
      url: r.url,
      snippet: (r.content ?? '').slice(0, 500),
      engine: r.engine,
      score: r.score,
      publishedDate: r.publishedDate,
    }));
  }

  private async callSearxng(url: string, params: Record<string, string>): Promise<SearxngResponse> {
    try {
      const res = await this.http.axiosRef.get<SearxngResponse>(`${url}/search`, {
        params,
        timeout: 15000,
        headers: { Accept: 'application/json' },
      });
      return res.data;
    } catch (err: unknown) {
      const msg = providerErrorMessage('SearXNG', err);
      this.logger.error(msg);
      throw new ServiceUnavailableException(msg);
    }
  }
}
