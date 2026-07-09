import { SettingsService } from '../../settings/settings.service';

/** Settings key for the SearXNG base URL override. */
export const SETTING_SEARXNG_URL = 'web_search_searxng_url';

/**
 * Resolves the SearXNG base URL: Settings DB → `SEARXNG_URL` env var →
 * `http://searxng:8080` default. Trailing slash stripped so callers can
 * safely append `/search` / `/healthz`.
 *
 * Shared by the `WebSearchModule` provider factory, `WebSearchService`, and
 * `WebSearchConfigService` so the resolution order lives in exactly one place.
 */
export async function resolveSearxngUrl(settings: SettingsService): Promise<string> {
  const envUrl = process.env.SEARXNG_URL || 'http://searxng:8080';
  const value = await settings.getOrDefault(SETTING_SEARXNG_URL, envUrl);
  return value.replace(/\/$/, '');
}
