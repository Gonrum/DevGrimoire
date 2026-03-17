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

function isPrivateIp(hostname: string): boolean {
  return PRIVATE_IP_RANGES.some((r) => r.test(hostname));
}

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '[::1]' || lower.endsWith('.local') || lower.endsWith('.internal');
}

export function validateGitBaseUrl(baseUrl: string | undefined): void {
  if (!baseUrl) return; // No custom baseUrl = use default (github.com/gitlab.com), always OK

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new BadRequestException(`Invalid base URL: ${baseUrl}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException('Base URL must use https:// or http://');
  }

  const hostname = parsed.hostname;

  // Block private IPs and hostnames (SSRF protection)
  if (isPrivateIp(hostname) || isPrivateHostname(hostname)) {
    throw new BadRequestException('Base URL must not point to private/internal addresses');
  }
}
