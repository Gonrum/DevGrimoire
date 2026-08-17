import { isRecord, isUnknownArray } from '../../common/narrow';
import { SearchProviderType } from './web-search-config.dto';

// Laufzeit-Liste + daraus abgeleiteter Typ: damit kann der Controller einen
// Query-String-Wert per `find` prüfen statt ihn mit `as SearchCategory[]` zu
// behaupten. `WebSearchService` filtert gegen dieselbe Liste.
export const SEARCH_CATEGORIES = ['general', 'news', 'science', 'it', 'files'] as const;
export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];

export function isSearchCategory(value: unknown): value is SearchCategory {
  return typeof value === 'string' && SEARCH_CATEGORIES.some((candidate) => candidate === value);
}

export type SearchTimeRange = 'day' | 'week' | 'month' | 'year';

export interface WebSearchQuery {
  query: string;
  language?: string;
  categories?: SearchCategory[];
  timeRange?: SearchTimeRange;
  limit?: number;
  /** Override the configured active provider for this one query. */
  provider?: SearchProviderType;
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

// `title`/`results` optional wie `SearxngProvider` sie liest (`r.title ?? ''`,
// `raw.results ?? []`). `score`/`publishedDate` setzt SearXNG je nach Engine —
// bleibt optional, denn ein Pflichtfeld hier hieße: jeder Treffer einer Engine,
// die keinen Score liefert, wäre ungültig.
export interface SearxngResultItem {
  url: string;
  title?: string;
  content?: string;
  engine: string;
  score?: number;
  publishedDate?: string;
  category?: string;
}

export interface SearxngResponse {
  query: string;
  number_of_results?: number;
  results?: SearxngResultItem[];
  engines?: string[];
  unresponsive_engines?: Array<[string, string]>;
}

// ---------------------------------------------------------------------------
// Cache-Leser
//
// `web_search_cache.payload` / `web_fetch_cache.payload` sind im Schema
// `Record<string, unknown>` — was drinsteht, hat eine frühere Programmversion
// geschrieben. Vorher stand an beiden Lesestellen
// `cached.payload as unknown as WebSearchResponse`: eine Behauptung, die einen
// halb geschriebenen oder in einem älteren Format abgelegten Eintrag als
// gültige Antwort durchließ (ein fehlendes `content` fiel erst beim Aufrufer
// auf, ein fehlendes `results` erst bei `.map`).
//
// **Optionale Felder bleiben optional.** `score` liefern nur Tavily und
// SearXNG, `publishedDate` nur ein Teil der Treffer, `siteName`/`excerpt` nur
// der Readability-Pfad. Ein Leser, der sie verlangt, würde jeden Cache-Eintrag
// der übrigen Provider verwerfen — also bei jedem Treffer erneut die (teils
// kostenpflichtige) API aufrufen. Streng ist der Leser nur bei dem, was die
// Antwort überhaupt verwertbar macht: `url` je Treffer, `results`/`query` bzw.
// `content`/`url` in der Antwort.
// ---------------------------------------------------------------------------

function readCachedHit(value: unknown): WebSearchHit | undefined {
  if (!isRecord(value) || typeof value.url !== 'string' || !value.url) return undefined;
  const hit: WebSearchHit = {
    title: typeof value.title === 'string' ? value.title : '',
    url: value.url,
    snippet: typeof value.snippet === 'string' ? value.snippet : '',
    engine: typeof value.engine === 'string' ? value.engine : '',
  };
  if (typeof value.score === 'number') hit.score = value.score;
  if (typeof value.publishedDate === 'string') hit.publishedDate = value.publishedDate;
  return hit;
}

/** Cache-Eintrag → Suchantwort, oder `undefined` = wie ein Cache-Miss behandeln. */
export function readCachedWebSearchResponse(payload: unknown): WebSearchResponse | undefined {
  if (!isRecord(payload)) return undefined;
  if (!isUnknownArray(payload.results) || typeof payload.query !== 'string') return undefined;
  const results = payload.results
    .map(readCachedHit)
    .filter((hit): hit is WebSearchHit => hit !== undefined);
  return {
    results,
    totalResults: typeof payload.totalResults === 'number' ? payload.totalResults : results.length,
    cached: true,
    query: payload.query,
    engines: isUnknownArray(payload.engines)
      ? payload.engines.filter((engine): engine is string => typeof engine === 'string')
      : [...new Set(results.map((hit) => hit.engine).filter(Boolean))],
  };
}

/** Cache-Eintrag → Fetch-Antwort, oder `undefined` = wie ein Cache-Miss behandeln. */
export function readCachedWebFetchResponse(payload: unknown): WebFetchResponse | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.content !== 'string' || typeof payload.url !== 'string') return undefined;
  const response: WebFetchResponse = {
    title: typeof payload.title === 'string' ? payload.title : '',
    content: payload.content,
    url: payload.url,
    cached: true,
    contentLength:
      typeof payload.contentLength === 'number' ? payload.contentLength : payload.content.length,
  };
  if (typeof payload.siteName === 'string') response.siteName = payload.siteName;
  if (typeof payload.excerpt === 'string') response.excerpt = payload.excerpt;
  if (typeof payload.publishedDate === 'string') response.publishedDate = payload.publishedDate;
  if (typeof payload.contentType === 'string') response.contentType = payload.contentType;
  return response;
}
