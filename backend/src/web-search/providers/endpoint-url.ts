/**
 * Endpoint-URLs für die Cloud-Provider, wenn ein Admin einen eigenen Endpoint
 * (Self-Host, Proxy, Firmen-Gateway) einträgt.
 *
 * Die Provider erwarteten bisher unterschiedliche Formen: Brave den vollen
 * Pfad bis `/res/v1/web/search`, Tavily die Basis-URL, an die `/search`
 * gehängt wurde. Wer bei Brave nur `https://brave.intern` eintrug, fragte die
 * Wurzel ab; wer bei Tavily `…/search` eintrug, landete auf `/search/search`.
 * Beide Formen werden jetzt akzeptiert und auf dieselbe Ziel-URL gebracht.
 */

export const BRAVE_DEFAULT_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
export const BRAVE_SEARCH_PATH = '/res/v1/web/search';
export const TAVILY_DEFAULT_BASE = 'https://api.tavily.com';

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Brave: reine Basis-URL (ohne Pfad) bekommt den Standard-Suchpfad angehängt. */
export function braveEndpoint(baseUrl?: string): string {
  const raw = baseUrl?.trim();
  if (!raw) return BRAVE_DEFAULT_ENDPOINT;
  const trimmed = stripTrailingSlashes(raw);
  try {
    const url = new URL(trimmed);
    if (url.pathname === '' || url.pathname === '/') {
      return `${url.origin}${BRAVE_SEARCH_PATH}${url.search}`;
    }
  } catch {
    // Kein parsebares URL-Format — unverändert durchreichen, axios meldet es.
  }
  return trimmed;
}

/** Tavily: Ziel ist immer `<basis>/search`, egal ob `/search` schon dasteht. */
export function tavilySearchEndpoint(baseUrl?: string): string {
  const raw = baseUrl?.trim();
  const base = raw ? stripTrailingSlashes(raw).replace(/\/search$/i, '') : TAVILY_DEFAULT_BASE;
  return `${base}/search`;
}
