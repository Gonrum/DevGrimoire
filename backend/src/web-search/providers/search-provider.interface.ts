export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
  score?: number;
  publishedDate?: string;
}

export interface SearchProviderOptions {
  limit?: number;
  language?: string;
  categories?: string;
  timeRange?: string;
}

export interface SearchProvider {
  readonly id: string;
  search(query: string, opts: SearchProviderOptions): Promise<SearchResult[]>;
}
