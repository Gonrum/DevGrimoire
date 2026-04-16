export type SearchCategory = 'general' | 'news' | 'science' | 'it' | 'files';
export type SearchTimeRange = 'day' | 'week' | 'month' | 'year';

export interface WebSearchQuery {
  query: string;
  language?: string;
  categories?: SearchCategory[];
  timeRange?: SearchTimeRange;
  limit?: number;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  engine: string;
  score?: number;
  publishedDate?: string;
}

export interface WebSearchResponse {
  results: WebSearchHit[];
  totalResults: number;
  cached: boolean;
  query: string;
  engines: string[];
}

export interface WebFetchQuery {
  url: string;
  raw?: boolean;
  maxLength?: number;
}

export interface WebFetchResponse {
  title: string;
  siteName?: string;
  content: string;
  excerpt?: string;
  publishedDate?: string;
  url: string;
  cached: boolean;
  contentLength: number;
  contentType?: string;
}

export interface SearxngResultItem {
  url: string;
  title: string;
  content?: string;
  engine: string;
  score?: number;
  publishedDate?: string;
  category?: string;
}

export interface SearxngResponse {
  query: string;
  number_of_results?: number;
  results: SearxngResultItem[];
  engines?: string[];
  unresponsive_engines?: Array<[string, string]>;
}
