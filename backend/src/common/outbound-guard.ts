import { ForbiddenException } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Outbound connections to user-configured targets (M-4).
 *
 * Internal targets are the core use case here — SSH servers, Kube clusters
 * and monitoring checks regularly live on `10.x`/`192.168.x`. A private-IP
 * block like the one in `readability.service.ts` (web_fetch) would switch
 * exactly that off. Only what is NEVER a legitimate target is blocked:
 *
 * - Loopback and "unspecified" (`0.0.0.0` connects locally on Linux) — that
 *   would be the backend container itself.
 * - Link-local including the cloud metadata address `169.254.169.254`, plus
 *   the metadata addresses outside link-local.
 * - This instance's services: its own interface addresses and the addresses
 *   of the compose services (MongoDB, Redis, MinIO, sidecar, …), and — inside
 *   a container — the default gateway (= the Docker host with its published
 *   ports, e.g. this instance's own :80 and :3200).
 *
 * Note: this also blocks services that run directly on the Docker host
 * (a local k3s/kind cluster, Gitea or SSH on the same machine). Allow them
 * explicitly via `OUTBOUND_ALLOW_HOSTS`.
 *
 * Checks run AFTER DNS resolution and against ALL addresses of a name —
 * otherwise a hostname pointing at `127.0.0.1`, or a second A record, would
 * do. `resolve()` returns the checked address; connecting to it instead of the
 * name also rules out DNS rebinding.
 *
 * Exceptions: `OUTBOUND_ALLOW_HOSTS` (comma list, host names or IPs, exact).
 */

export const OUTBOUND_BLOCKED_CODE = 'outbound_blocked';

export class OutboundBlockedException extends ForbiddenException {
  readonly code = OUTBOUND_BLOCKED_CODE;
  constructor(readonly host: string, readonly reason: BlockReason) {
    super(
      `${OUTBOUND_BLOCKED_CODE}: Ziel ${host} ist nicht erlaubt (${REASON_TEXT[reason]}). ` +
        'Ausnahmen über OUTBOUND_ALLOW_HOSTS.',
    );
  }
}

export type BlockReason = 'loopback' | 'unspecified' | 'link-local' | 'metadata' | 'instance';

const REASON_TEXT: Record<BlockReason, string> = {
  loopback: 'Loopback',
  unspecified: 'unspezifizierte Adresse',
  'link-local': 'Link-Local',
  metadata: 'Cloud-Metadaten-Dienst',
  instance: 'Dienst dieser Instanz',
};

/** Metadaten-Endpunkte, die nicht schon in Link-Local liegen. */
const METADATA_ADDRESSES = new Set(['100.100.100.200', 'fd00:ec2:0:0:0:0:0:254']);

/** Compose-Dienstnamen dieser Instanz (`docker-compose.yml`). */
const DEFAULT_INSTANCE_HOSTS = [
  'mongodb', 'redis', 'workspace', 'searxng', 'backend', 'frontend', 'minio',
  // Docker's alias for the host gateway (when configured via extra_hosts).
  'host.docker.internal',
];

const INSTANCE_CACHE_MS = 60_000;

export interface ResolvedOutbound {
  /** Geprüfte Adresse — damit verbinden, nicht mit dem Namen. */
  address: string;
  family: 4 | 6;
}

export interface OutboundGuardDeps {
  lookup: (host: string) => Promise<Array<{ address: string; family: number }>>;
  interfaceAddresses: () => string[];
  env: NodeJS.ProcessEnv;
  now: () => number;
  /**
   * Default-gateway addresses of the container. Inside a Docker bridge the
   * gateway IS the Docker host, which reaches every port the host publishes
   * (MongoDB, the backend itself, MinIO …) — an instance service by another
   * address. Optional so callers/tests without it keep working.
   */
  gatewayAddresses?: () => string[];
}

/** Volle 8-Gruppen-Form einer IPv6-Adresse, `null` wenn keine. */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // Eingebettete IPv4 am Ende (`::ffff:1.2.3.4`) in zwei Hex-Gruppen wandeln.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) +
      `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array<string>(Math.max(fill, 0)).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** Kanonische Form für Vergleiche: IPv4 gepunktet, IPv6 voll ausgeschrieben, IPv4-mapped als IPv4. */
export function canonicalIp(ip: string): string {
  const bare = ip.replace(/^\[|\]$/g, '');
  if (isIP(bare) === 4) return bare;
  const g = expandV6(bare);
  if (!g) return bare.toLowerCase();
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  }
  return g.map((x) => x.toString(16)).join(':');
}

/** Grundsätzlich gesperrte Adressklasse, unabhängig von der Instanz. */
export function classifyAddress(ip: string): BlockReason | null {
  const c = canonicalIp(ip);
  if (METADATA_ADDRESSES.has(c)) return 'metadata';
  if (isIP(c) === 4) {
    const [a, b] = c.split('.').map(Number);
    if (a === 127) return 'loopback';
    if (a === 0) return 'unspecified';
    if (a === 169 && b === 254) return 'link-local';
    return null;
  }
  const g = expandV6(c);
  if (!g) return null;
  if (g.every((x) => x === 0)) return 'unspecified';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  return null;
}

function isV6LinkLocal(ip: string): boolean {
  return isIP(canonicalIp(ip)) === 6 && classifyAddress(ip) === 'link-local';
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function hostOfUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try { return new URL(raw).hostname.replace(/^\[|\]$/g, '') || null; } catch { return null; }
}

/** Hosts aus `MONGODB_URI` — mehrere bei einem Replica-Set-String, ohne Ports. */
function mongoHosts(uri: string | undefined): string[] {
  const m = uri ? /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(uri) : null;
  if (!m) return [];
  return m[1].split(',').map((h) => h.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')).filter(Boolean);
}

/** `MINIO_ENDPOINT` is a bare host (`minio`, `minio:9000`) or, rarely, a URL. */
function minioHost(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (v.includes('://')) return hostOfUrl(v)?.toLowerCase() ?? null;
  if (v.startsWith('[')) return v.slice(1, v.indexOf(']') > 0 ? v.indexOf(']') : undefined).toLowerCase() || null;
  // A single colon is a port; several mean a bare IPv6 literal.
  const bare = v.split(':').length === 2 ? v.replace(/:\d+$/, '') : v;
  return bare.toLowerCase() || null;
}

/** Little-endian hex IPv4 from /proc/net/route (`0102A8C0` -> `192.168.2.1`). */
function hexV4(hex: string): string | null {
  if (!/^[0-9a-f]{8}$/i.test(hex)) return null;
  const n = parseInt(hex, 16);
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.');
}

/** Gateways of the default routes in `/proc/net/route` (IPv4). */
export function parseProcNetRoute(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8) continue;
    const [, dest, gateway, , , , , mask] = cols;
    if (dest !== '00000000' || mask !== '00000000') continue;
    const ip = hexV4(gateway);
    if (ip && ip !== '0.0.0.0') out.push(ip);
  }
  return out;
}

/** Next hops of the default routes in `/proc/net/ipv6_route`. */
export function parseProcNetIpv6Route(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const [dest, prefix, , , nextHop] = cols;
    if (!/^0{32}$/.test(dest) || prefix !== '00' || !/^[0-9a-f]{32}$/i.test(nextHop) || /^0{32}$/.test(nextHop)) continue;
    out.push(canonicalIp(nextHop.match(/.{4}/g)?.join(':') ?? ''));
  }
  return out;
}

/**
 * Best-effort default gateways — only inside a container, where the gateway
 * is the Docker host. On a bare host the gateway is the LAN router, which may
 * be a legitimate monitoring target. Exceptions go through OUTBOUND_ALLOW_HOSTS
 * (the gateway IP, or `host.docker.internal`).
 */
function readDefaultGateways(): string[] {
  const inContainer = existsSync('/.dockerenv') || existsSync('/run/.containerenv');
  if (!inContainer) return [];
  const read = (path: string): string => {
    try { return readFileSync(path, 'utf8'); } catch { return ''; }
  };
  return [...parseProcNetRoute(read('/proc/net/route')), ...parseProcNetIpv6Route(read('/proc/net/ipv6_route'))];
}

export function instanceHosts(env: NodeJS.ProcessEnv): string[] {
  const hosts = new Set<string>(DEFAULT_INSTANCE_HOSTS);
  for (const h of mongoHosts(env.MONGODB_URI)) hosts.add(h.toLowerCase());
  if (env.REDIS_HOST) hosts.add(env.REDIS_HOST.toLowerCase());
  const minio = minioHost(env.MINIO_ENDPOINT);
  if (minio) hosts.add(minio);
  for (const u of [env.WORKSPACE_API_URL, env.SEARXNG_URL]) {
    const h = hostOfUrl(u);
    if (h) hosts.add(h.toLowerCase());
  }
  return [...hosts];
}

export function createOutboundGuard(deps: OutboundGuardDeps) {
  let instanceCache: { at: number; ips: Promise<Set<string>> } | null = null;

  function allowList(): Set<string> {
    return new Set(splitList(deps.env.OUTBOUND_ALLOW_HOSTS).map((h) => (isIP(h.replace(/^\[|\]$/g, '')) ? canonicalIp(h) : h)));
  }

  async function collectInstanceIps(allow: Set<string>): Promise<Set<string>> {
    const ips = new Set<string>();
    for (const ip of deps.interfaceAddresses()) ips.add(canonicalIp(ip));
    // An allowlisted gateway IP is still honoured by the per-address allow
    // check in resolve().
    if (deps.gatewayAddresses) {
      try {
        for (const ip of deps.gatewayAddresses()) ips.add(canonicalIp(ip));
      } catch {
        // Best-effort: no route table readable — nothing to add.
      }
    }
    const names = instanceHosts(deps.env).filter((h) => !allow.has(h));
    await Promise.all(names.map(async (name) => {
      try {
        for (const { address } of await deps.lookup(name)) ips.add(canonicalIp(address));
      } catch {
        // Nicht auflösbar (Backend läuft ausserhalb von Compose) — kein Dienst dieser Instanz.
      }
    }));
    return ips;
  }

  function instanceIps(allow: Set<string>): Promise<Set<string>> {
    const now = deps.now();
    if (!instanceCache || now - instanceCache.at > INSTANCE_CACHE_MS) {
      const ips = collectInstanceIps(allow);
      instanceCache = { at: now, ips };
      ips.catch(() => { instanceCache = null; });
    }
    return instanceCache.ips;
  }

  /**
   * Löst `host` auf und prüft jede Adresse. Wirft `OutboundBlockedException`
   * bei einem gesperrten Ziel; ein DNS-Fehler geht unverändert durch (er ist
   * auch ohne Guard der Verbindungsfehler, den der Aufrufer schon kennt).
   */
  async function resolve(rawHost: string): Promise<ResolvedOutbound> {
    const host = rawHost.trim().replace(/^\[|\]$/g, '');
    const lower = host.toLowerCase();
    const allow = allowList();
    const literal = isIP(host);

    // Freigegebener Name: keine Prüfung, keine eigene Auflösung — verbunden
    // wird wie ohne Guard über den Namen.
    if (allow.has(lower)) return { address: host, family: literal === 6 ? 6 : 4 };

    let addresses: Array<{ address: string; family: number }>;
    if (literal) {
      addresses = [{ address: host, family: literal }];
    } else {
      // Vor DNS: `localhost` kann /etc/hosts beliebig umbiegen.
      if (lower === 'localhost' || lower.endsWith('.localhost')) {
        throw new OutboundBlockedException(host, 'loopback');
      }
      const found = await deps.lookup(host);
      if (found.length === 0) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      // IPv6-Link-Local aus DNS ignorieren statt sperren: Heimrouter (Speedport,
      // Fritzbox) liefern für LAN-Namen neben der IPv4 eine `fe80::`-Adresse
      // mit. Ohne Zone-ID ist sie ohnehin nicht verbindbar; gesperrt bliebe
      // sonst jedes LAN-Ziel. Verbunden wird nur mit einer geprüften Adresse.
      addresses = found.filter(({ address }) => !isV6LinkLocal(address));
      if (addresses.length === 0) throw new OutboundBlockedException(host, 'link-local');
    }

    const own = await instanceIps(allow);
    for (const { address } of addresses) {
      const c = canonicalIp(address);
      if (allow.has(c)) continue;
      const reason = classifyAddress(c) ?? (own.has(c) ? 'instance' : null);
      if (reason) throw new OutboundBlockedException(host, reason);
    }
    const first = addresses[0];
    return { address: first.address, family: first.family === 6 ? 6 : 4 };
  }

  /** Prüft den Host einer URL; Rückgabe wie `resolve()`. */
  async function assertUrl(url: string | URL): Promise<ResolvedOutbound> {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return resolve(parsed.hostname);
  }

  return { resolve, assertUrl };
}

export const outboundGuard = createOutboundGuard({
  lookup: (host) => dnsLookup(host, { all: true, verbatim: true }),
  interfaceAddresses: () =>
    Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address)),
  env: process.env,
  now: () => Date.now(),
  gatewayAddresses: readDefaultGateways,
});
