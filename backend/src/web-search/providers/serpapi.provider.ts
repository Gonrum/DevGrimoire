import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { SearchProvider, SearchProviderOptions, SearchResult } from './search-provider.interface';
import { providerErrorMessage } from './provider-error';

// `title` optional wie der Mapper es liest (`r.title ?? ''`); `link` bleibt
// zugesagt, ohne Link gibt es kein Ergebnis. `date` liefert Google nur für
// datierte Treffer — deshalb optional und nicht auf '' normalisiert.
interface SerpApiResultItem {
  title?: string;
  link: string;
  snippet?: string;
  date?: string;
}

interface SerpApiResponse {
  organic_results?: SerpApiResultItem[];
}

/**
 * SerpApi (Google engine)-backed SearchProvider adapter.
 *
 * SerpApi proxies Google Search results via `organic_results`, with `link`
 * mapping to our `url` and `snippet` passed through as-is. The API key is
 * sent as a query param (`api_key`), consistent with SerpApi's REST contract.
 */
@Injectable()
export class SerpApiProvider implements SearchProvider {
  readonly id = 'serpapi';
  private readonly logger = new Logger(SerpApiProvider.name);

  constructor(
    private readonly http: HttpService,
    private readonly cfg: { apiKey: string; baseUrl?: string },
  ) {}

  async search(query: string, opts: SearchProviderOptions): Promise<SearchResult[]> {
    const baseUrl = this.cfg.baseUrl || 'https://serpapi.com/search';
    const params: Record<string, string | number> = {
      engine: 'google',
      q: query,
      num: opts.limit ?? 5,
      api_key: this.cfg.apiKey,
    };

    const raw = await this.callSerpApi(baseUrl, params);
    const results = raw.organic_results ?? [];

    return results.map((r) => ({
      title: r.title ?? '',
      url: r.link,
      snippet: r.snippet ?? '',
      publishedDate: r.date,
    }));
  }

  private async callSerpApi(
    baseUrl: string,
    params: Record<string, string | number>,
  ): Promise<SerpApiResponse> {
    try {
      const res = await this.http.axiosRef.get<SerpApiResponse>(baseUrl, {
        params,
        timeout: 15000,
        headers: { Accept: 'application/json' },
      });
      return res.data;
    } catch (err: unknown) {
      const msg = providerErrorMessage('SerpApi', err);
      this.logger.error(msg);
      throw new ServiceUnavailableException(msg);
    }
  }
}
