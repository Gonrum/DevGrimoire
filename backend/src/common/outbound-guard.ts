import { ForbiddenException } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * Ausgehende Verbindungen zu nutzerkonfigurierten Zielen (M-4).
 *
 * Interne Ziele sind hier Kernnutzen — SSH-Server, Kube-Cluster und
 * Monitoring-Checks liegen regulär auf `10.x`/`192.168.x`. Eine
 * Private-IP-Sperre wie in `readability.service.ts` (web_fetch) würde genau das
 * abschalten. Gesperrt wird deshalb nur, was **nie** ein legitimes Ziel ist:
 *
 * - Loopback und „unspecified" (`0.0.0.0` verbindet unter Linux nach lokal) —
 *   das wäre der Backend-Container selbst.
 * - Link-Local inklusive der Cloud-Metadaten-Adresse `169.254.169.254`, dazu
 *   die Metadaten-Adressen, die ausserhalb von Link-Local liegen.
 * - Die Dienste dieser Instanz: die eigenen Interface-Adressen und die
 *   Adressen der Compose-Dienste (MongoDB, Redis, Sidecar, …).
 *
 * Geprüft wird **nach** der DNS-Auflösung und gegen **alle** Adressen eines
 * Namens — sonst reicht ein Hostname, der auf `127.0.0.1` zeigt, oder ein
 * zweiter A-Record. `resolve()` liefert die geprüfte Adresse zurück; wer mit
 * ihr statt mit dem Namen verbindet, schliesst auch DNS-Rebinding aus.
 *
 * Ausnahmen: `OUTBOUND_ALLOW_HOSTS` (Komma-Liste, Hostnamen oder IPs, exakt).
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
const DEFAULT_INSTANCE_HOSTS = ['mongodb', 'redis', 'workspace', 'searxng', 'backend', 'frontend'];

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

export function instanceHosts(env: NodeJS.ProcessEnv): string[] {
  const hosts = new Set<string>(DEFAULT_INSTANCE_HOSTS);
  for (const h of mongoHosts(env.MONGODB_URI)) hosts.add(h.toLowerCase());
  if (env.REDIS_HOST) hosts.add(env.REDIS_HOST.toLowerCase());
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
});
