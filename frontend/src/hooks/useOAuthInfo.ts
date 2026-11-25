import { useEffect, useState } from 'react';
import { api, OAuthInfo } from '../api/client';

/**
 * `GET /api/oauth/info` changes only with a backend restart, so one request
 * per page load is enough; every caller shares it. A failed request is
 * dropped from the cache so the next mount tries again.
 */
let cached: Promise<OAuthInfo> | null = null;

function loadOAuthInfo(): Promise<OAuthInfo> {
  if (!cached) {
    cached = api.oauth.info().catch((err: unknown) => {
      cached = null;
      throw err;
    });
  }
  return cached;
}

/** OAuth switch and MCP URL; `null` while loading or when the request failed. */
export function useOAuthInfo(): OAuthInfo | null {
  const [info, setInfo] = useState<OAuthInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadOAuthInfo()
      .then((res) => { if (!cancelled) setInfo(res); })
      .catch(() => { /* treated as "OAuth unknown": the API-key variant is shown */ });
    return () => { cancelled = true; };
  }, []);
  return info;
}

/** Placeholder used in the docs when the instance address is not known. */
export const SERVER_PLACEHOLDER = 'http://[server]';

/** `https://host` from `https://host/mcp`, or the placeholder. */
export function serverBaseFrom(info: OAuthInfo | null): string {
  const url = info?.enabled ? info.mcpUrl : undefined;
  if (!url) return SERVER_PLACEHOLDER;
  return url.endsWith('/mcp') ? url.slice(0, -'/mcp'.length) : url;
}
