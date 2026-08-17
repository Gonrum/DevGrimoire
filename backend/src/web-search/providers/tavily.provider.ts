import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { SearchProvider, SearchProviderOptions, SearchResult } from './search-provider.interface';
import { providerErrorMessage } from './provider-error';

// `title` und `results` optional wie der Mapper sie liest (`r.title ?? ''`,
// `raw.results ?? []`). `score`/`published_date` liefert Tavily je Treffer
// unterschiedlich — beides bleibt optional und wird nicht ersetzt.
interface TavilyResultItem {
  title?: string;
  url: string;
  content?: string;
  score?: number;
  published_date?: string;
}

interface TavilyResponse {
  results?: TavilyResultItem[];
}

/**
 * Tavily-backed SearchProvider adapter.
 *
 * Tavily's `/search` endpoint takes the API key in the JSON body (not a header)
 * and returns results with a `content` field that maps to our `snippet`.
 */
@Injectable()
export class TavilyProvider implements SearchProvider {
  readonly id = 'tavily';
  private readonly logger = new Logger(TavilyProvider.name);

  constructor(
    private readonly http: HttpService,
    private readonly cfg: { apiKey: string; baseUrl?: string },
  ) {}

  async search(query: string, opts: SearchProviderOptions): Promise<SearchResult[]> {
    const baseUrl = this.cfg.baseUrl || 'https://api.tavily.com';
    const body = {
      api_key: this.cfg.apiKey,
      query,
      max_results: opts.limit ?? 5,
      search_depth: 'basic',
    };

    const raw = await this.callTavily(baseUrl, body);
    const results = raw.results ?? [];

    return results.map((r) => ({
      title: r.title ?? '',
      url: r.url,
      snippet: r.content ?? '',
      score: r.score,
      publishedDate: r.published_date,
    }));
  }

  private async callTavily(
    baseUrl: string,
    body: Record<string, unknown>,
  ): Promise<TavilyResponse> {
    try {
      const res = await this.http.axiosRef.post<TavilyResponse>(`${baseUrl}/search`, body, {
        timeout: 15000,
        headers: { Accept: 'application/json' },
      });
      return res.data;
    } catch (err: unknown) {
      const msg = providerErrorMessage('Tavily', err);
      this.logger.error(msg);
      throw new ServiceUnavailableException(msg);
    }
  }
}
