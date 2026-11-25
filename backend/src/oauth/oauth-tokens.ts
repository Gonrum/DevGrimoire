import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';

/**
 * Pure helpers of the MCP OAuth server: secret generation, hashing, PKCE and
 * the registration rules for redirect URIs and client names. No I/O here so
 * the rules can be checked in isolation.
 */

/** Prefix of OAuth access tokens; API keys stay `cv_…`. */
export const ACCESS_TOKEN_PREFIX = 'dgo_at_';
/** Prefix of OAuth refresh tokens. */
export const REFRESH_TOKEN_PREFIX = 'dgo_rt_';

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 60 * 1000;
export const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
export const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
/** A just-replaced refresh token presented again within this window is a race, not theft. */
export const REFRESH_REUSE_GRACE_MS = 10 * 1000;
/** Lifetime of the hidden API key behind an approved connection. */
export const CONNECTION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/**
 * Used codes are kept this long past their expiry so a late replay is still
 * recognised as a replay (and revokes the connection) rather than as unknown.
 */
export const CODE_REPLAY_RETENTION_SEC = 10 * 60;

export const MAX_CLIENT_NAME_LENGTH = 100;
export const MAX_REDIRECT_URIS = 5;
export const MAX_REDIRECT_URI_LENGTH = 500;
/** Upper bound for opaque values we only store and echo (state, challenge, scopes). */
export const MAX_ECHO_LENGTH = 1024;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Control characters (C0, DEL, C1), zero-width marks, bidi overrides/isolates
 * and line/paragraph separators: anything that could make a client name
 * render differently on the consent page from what it really is.
 */
function isUnsafeNameChar(c: number): boolean {
  return (
    c <= 0x1f ||
    (c >= 0x7f && c <= 0x9f) ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x2028 && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x2069) ||
    c === 0xfeff
  );
}

function hasUnsafeNameChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isUnsafeNameChar(value.charCodeAt(i))) return true;
  }
  return false;
}

/** 32 random bytes, base64url without padding. */
export function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function newAccessToken(): string {
  return ACCESS_TOKEN_PREFIX + randomSecret();
}

export function newRefreshToken(): string {
  return REFRESH_TOKEN_PREFIX + randomSecret();
}

export function newAuthCode(): string {
  return randomSecret();
}

export function newRequestId(): string {
  return randomSecret();
}

export function newClientId(): string {
  return randomUUID();
}

/** SHA-256 hex — the only form in which tokens, codes and request ids are stored. */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison of two strings of possibly different length. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
const PKCE_VALUE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidPkceValue(value: unknown): value is string {
  return typeof value === 'string' && PKCE_VALUE.test(value);
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!isValidPkceValue(verifier)) return false;
  return safeEqual(pkceS256(verifier), challenge);
}

/**
 * Registration rule for redirect URIs: `https://…` anywhere, plain `http`
 * only to a loopback host (RFC 8252 native clients such as Claude Code).
 * No fragment (RFC 6749 §3.1.2), no userinfo (phishing via `https://claude.ai@evil`).
 */
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== 'string' || uri.length === 0) return 'redirect_uri must be a non-empty string';
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return `redirect_uri longer than ${MAX_REDIRECT_URI_LENGTH} characters`;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'redirect_uri is not a valid URL';
  }
  if (url.hash || uri.includes('#')) return 'redirect_uri must not contain a fragment';
  if (url.username || url.password) return 'redirect_uri must not contain credentials';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return null;
  return 'redirect_uri must use https, or http on localhost/127.0.0.1/[::1]';
}

/**
 * Whether a redirect URI requested at /authorize matches a registered one:
 * exact match, or for loopback hosts any port (RFC 8252 §7.3) with scheme,
 * host, path and query still identical. Same rule as the SDK's authorize
 * handler, repeated here so the service does not depend on its caller.
 */
export function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  let req: URL;
  let reg: URL;
  try {
    req = new URL(requested);
    reg = new URL(registered);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(req.hostname) || !LOOPBACK_HOSTS.has(reg.hostname)) return false;
  return (
    req.protocol === reg.protocol &&
    req.hostname === reg.hostname &&
    req.pathname === reg.pathname &&
    req.search === reg.search &&
    !req.hash
  );
}

export function clientNameProblem(name: unknown): string | null {
  if (name === undefined) return null;
  if (typeof name !== 'string') return 'client_name must be a string';
  if (name.trim().length === 0) return 'client_name must not be blank';
  if (name.length > MAX_CLIENT_NAME_LENGTH) return `client_name longer than ${MAX_CLIENT_NAME_LENGTH} characters`;
  if (hasUnsafeNameChar(name)) return 'client_name contains control or bidi characters';
  return null;
}

/** Canonical form of a resource indicator for comparison: parsed, without fragment. */
export function canonicalResource(resource: string | URL): string | null {
  try {
    const url = new URL(typeof resource === 'string' ? resource : resource.href);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * `<PUBLIC_BASE_URL>/mcp`, or null when the base URL is missing or not an
 * absolute http(s) URL without path, query or fragment (OAuth stays off then).
 */
export function oauthResourceFromBaseUrl(baseUrl: string | undefined): string | null {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
  return `${url.origin}/mcp`;
}
