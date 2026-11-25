import { oauthResourceFromBaseUrl } from './oauth-tokens';

/** Whether the MCP OAuth server runs, and under which public addresses. */
export interface OAuthConfig {
  enabled: boolean;
  /** `PUBLIC_BASE_URL` as a URL: issuer and base of /authorize, /token, … */
  baseUrl?: URL;
  /** `<PUBLIC_BASE_URL>/mcp`: the protected resource tokens are bound to. */
  resourceUrl?: URL;
  /** Why OAuth is off despite a configured base URL (for the boot log). */
  problem?: string;
}

type Env = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * OAuth runs only with a valid `PUBLIC_BASE_URL` and with authentication on.
 * Authentication is on exactly when AuthService says so (AUTH_USERNAME and
 * AUTH_PASSWORD set); `AUTH_ENABLED=false` additionally switches OAuth off.
 * The base URL must be https (plain http only for localhost/127.0.0.1),
 * which is also what the SDK router demands of an issuer. When OAuth is off
 * there is no router, no metadata and no `WWW-Authenticate` hint; API keys
 * keep working either way.
 */
export function oauthConfig(env: Env = process.env): OAuthConfig {
  const raw = env.PUBLIC_BASE_URL?.trim();
  if (!raw) return { enabled: false };
  if (env.AUTH_ENABLED?.trim().toLowerCase() === 'false') {
    return { enabled: false, problem: 'AUTH_ENABLED=false' };
  }
  if (!env.AUTH_USERNAME || !env.AUTH_PASSWORD) {
    return { enabled: false, problem: 'authentication is off (AUTH_USERNAME/AUTH_PASSWORD unset)' };
  }
  const resource = oauthResourceFromBaseUrl(raw);
  if (!resource) {
    return { enabled: false, problem: 'PUBLIC_BASE_URL must be an absolute URL without path, query or fragment' };
  }
  const resourceUrl = new URL(resource);
  if (resourceUrl.protocol !== 'https:' && !LOOPBACK_HOSTS.has(resourceUrl.hostname)) {
    return { enabled: false, problem: 'PUBLIC_BASE_URL must use https' };
  }
  return { enabled: true, baseUrl: new URL(resourceUrl.origin), resourceUrl };
}
