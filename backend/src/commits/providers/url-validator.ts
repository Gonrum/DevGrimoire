import { BadRequestException } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { guardedFetch } from '../../common/guarded-fetch';
import { canonicalIp, outboundGuard, ResolvedOutbound } from '../../common/outbound-guard';

/**
 * Outbound policy for git hosts. The provider requests carry the repository
 * token and are triggered by the commit cron without an actor, so the target
 * must be checked on every request, after DNS resolution:
 *
 * 1. Always: `outboundGuard` (loopback, link-local/metadata, this instance's
 *    own services incl. compose single-label names like `mongodb`).
 * 2. Unless the repository has `allowPrivateHost` (admin-granted, see
 *    `ProjectsService.assertGitRepositoriesAllowed`): no private/internal
 *    address and no single-label hostname. The previous check only matched
 *    the literal hostname — `git.example.com -> 10.0.0.5` or `gitea` (docker
 *    DNS) passed.
 */

const PRIVATE_V4 = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
];

function isPrivateAddress(ip: string): boolean {
  const c = canonicalIp(ip);
  if (isIP(c) === 4) return PRIVATE_V4.some((r) => r.test(c));
  const lower = c.toLowerCase();
  // canonicalIp writes IPv6 fully expanded without leading zeros.
  return lower === '0:0:0:0:0:0:0:1' || lower === '0:0:0:0:0:0:0:0'
    || /^fe[89ab][0-9a-f]:/.test(lower) || /^f[cd][0-9a-f]{2}:/.test(lower);
}

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  if (lower.endsWith('.local') || lower.endsWith('.internal') || lower.endsWith('.lan')) return true;
  // Single-label names resolve via docker/search-domain DNS to internal hosts.
  return !isIP(lower) && !lower.includes('.');
}

export interface GitTargetDeps {
  lookup: (host: string) => Promise<Array<{ address: string }>>;
  guard: Pick<typeof outboundGuard, 'assertUrl'>;
}

const defaultDeps: GitTargetDeps = {
  lookup: (host) => dnsLookup(host, { all: true, verbatim: true }),
  guard: outboundGuard,
};

/** Cheap synchronous pre-check of the configured base URL (format, protocol). */
export function validateGitBaseUrl(baseUrl: string | undefined, allowPrivateHost = false): void {
  if (!baseUrl) return;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new BadRequestException(`Invalid base URL: ${baseUrl}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException('Base URL must use https:// or http://');
  }
  if (!allowPrivateHost && isPrivateHostname(parsed.hostname.replace(/^\[|\]$/g, ''))) {
    throw new BadRequestException('Base URL must not point to private/internal addresses');
  }
}

/** Full check of one request target, after DNS resolution (see file comment). */
export async function assertGitTarget(
  url: URL,
  allowPrivateHost: boolean,
  deps: GitTargetDeps = defaultDeps,
): Promise<ResolvedOutbound> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BadRequestException('Git host URL must use https:// or http://');
  }
  const resolved = await deps.guard.assertUrl(url);
  if (allowPrivateHost) return resolved;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHostname(host)) {
    throw new BadRequestException('Git host must not point to private/internal addresses');
  }
  const addresses = isIP(host) ? [host] : (await deps.lookup(host)).map((a) => a.address);
  if (addresses.some(isPrivateAddress)) {
    throw new BadRequestException('Git host must not point to private/internal addresses');
  }
  return resolved;
}

/**
 * `fetch` for git provider APIs: every hop (including redirects) goes through
 * `assertGitTarget`; credential headers are dropped on cross-origin redirects
 * by `guardedFetch`.
 */
export function gitFetch(
  config: { allowPrivateHost?: boolean },
  url: string,
  init: RequestInit,
): Promise<Response> {
  const allowPrivate = config.allowPrivateHost === true;
  return guardedFetch(url, init, {
    followRedirects: true,
    guard: { assertUrl: (u) => assertGitTarget(typeof u === 'string' ? new URL(u) : u, allowPrivate) },
  });
}
