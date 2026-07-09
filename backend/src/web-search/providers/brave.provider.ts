import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { AxiosError } from 'axios';
import { SearchProvider, SearchProviderOptions, SearchResult } from './search-provider.interface';

interface BraveResultItem {
  title: string;
  url: string;
  description?: string;
  age?: string;
}

interface BraveResponse {
  web?: {
    results: BraveResultItem[];
  };
}

/**
 * Brave Search-backed SearchProvider adapter.
 *
 * Brave's Web Search API authenticates via the `X-Subscription-Token` header
 * and nests organic results under `web.results`, with `description` mapping
 * to our `snippet`.
 */
@Injectable()
export class BraveProvider implements SearchProvider {
  readonly id = 'brave';
  private readonly logger = new Logger(BraveProvider.name);

  constructor(
    private readonly http: HttpService,
    private readonly cfg: { apiKey: string; baseUrl?: string },
  ) {}

  async search(query: string, opts: SearchProviderOptions): Promise<SearchResult[]> {
    const baseUrl = this.cfg.baseUrl || 'https://api.search.brave.com/res/v1/web/search';
    const params: Record<string, string | number> = {
      q: query,
      count: opts.limit ?? 5,
    };

    const raw = await this.callBrave(baseUrl, params);
    const results = raw.web?.results ?? [];

    return results.map((r) => ({
      title: r.title ?? '',
      url: r.url,
      snippet: r.description ?? '',
    }));
  }

  private async callBrave(
    baseUrl: string,
    params: Record<string, string | number>,
  ): Promise<BraveResponse> {
    try {
      const res = await this.http.axiosRef.get<BraveResponse>(baseUrl, {
        params,
        timeout: 15000,
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': this.cfg.apiKey,
        },
      });
      return res.data;
    } catch (err) {
      const ax = err as AxiosError;
      const msg = ax.response
        ? `Brave returned ${ax.response.status}`
        : ax.code === 'ECONNABORTED'
          ? 'Brave timeout'
          : `Brave unreachable: ${ax.message}`;
      this.logger.error(msg);
      throw new ServiceUnavailableException(msg);
    }
  }
}
