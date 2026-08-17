import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { SearchProvider, SearchProviderOptions, SearchResult } from './search-provider.interface';
import { providerErrorMessage } from './provider-error';

// `title` und `web.results` sind optional deklariert, weil der Mapper unten
// genau so damit umgeht (`r.title ?? ''`, `raw.web?.results ?? []`). Nur `url`
// gilt als zugesagt — ein organisches Ergebnis ohne URL wäre kein Ergebnis.
interface BraveResultItem {
  title?: string;
  url: string;
  description?: string;
  age?: string;
}

interface BraveResponse {
  web?: {
    results?: BraveResultItem[];
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
    } catch (err: unknown) {
      const msg = providerErrorMessage('Brave', err);
      this.logger.error(msg);
      throw new ServiceUnavailableException(msg);
    }
  }
}
