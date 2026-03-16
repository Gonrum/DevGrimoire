import { BadRequestException } from '@nestjs/common';

const PRIVATE_IP_RANGES = [
  /^127\./,                          // Loopback
  /^10\./,                           // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])\./,     // RFC 1918
  /^192\.168\./,                     // RFC 1918
  /^169\.254\./,                     // Link-local
  /^0\./,                            // "This" network
  /^::1$/,                           // IPv6 loopback
  /^fe80:/i,                         // IPv6 link-local
  /^fc00:/i,                         // IPv6 unique local
  /^fd/i,                            // IPv6 unique local
];

const DEFAULT_ALLOWED_HOSTS = [
  'api.github.com',
  'github.com',
  'gitlab.com',
];

function isPrivateIp(hostname: string): boolean {
  return PRIVATE_IP_RANGES.some((r) => r.test(hostname));
}

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '[::1]' || lower.endsWith('.local') || lower.endsWith('.internal');
}

export function validateGitBaseUrl(baseUrl: string | undefined, allowedHosts?: string[]): void {
  if (!baseUrl) return; // No custom baseUrl = use default (github.com/gitlab.com), always OK

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new BadRequestException(`Invalid base URL: ${baseUrl}`);
  }

  // Must be HTTPS (except in dev/test)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException('Base URL must use https:// or http://');
  }

  const hostname = parsed.hostname;

  // Block private IPs and hostnames
  if (isPrivateIp(hostname) || isPrivateHostname(hostname)) {
    throw new BadRequestException('Base URL must not point to private/internal addresses');
  }

  // Check allowed hosts (default + configured)
  const allowed = [...DEFAULT_ALLOWED_HOSTS, ...(allowedHosts || [])];
  const configuredHosts = (process.env.GIT_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
  allowed.push(...configuredHosts);

  // If allowedHosts are configured, enforce them
  if (allowed.length > 0 && !allowed.some((h) => hostname === h || hostname.endsWith(`.${h}`))) {
    throw new BadRequestException(
      `Base URL host "${hostname}" is not in the allowed hosts list. Configure GIT_ALLOWED_HOSTS env var to allow additional hosts.`,
    );
  }
}
