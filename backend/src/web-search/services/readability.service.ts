import { Injectable, Logger, BadRequestException, ServiceUnavailableException, ForbiddenException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { isAxiosError } from 'axios';
// `isomorphic-dompurify` wird hier nicht mehr importiert — siehe Kommentar in
// `extractReadable`.
import { HttpService } from '@nestjs/axios';
import { errorMessage } from '../../common/narrow';
import { WebSearchService } from './web-search.service';
import { WebSearchRateLimiterService } from './web-search-rate-limiter.service';
import { ConcurrencyLimiter } from './concurrency-limiter';
import { WebFetchCache, WebFetchCacheDocument } from '../schemas/web-fetch-cache.schema';
import { WebFetchResponse, WebFetchQuery, readCachedWebFetchResponse } from '../dto/web-search.dto';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_MAX_LENGTH = 50_000;
const USER_AGENT = 'DevGrimoire-WebFetch/1.0 (+https://github.com/devgrimoire)';
const MAX_CONCURRENT_FETCHES = 3;

@Injectable()
export class ReadabilityService {
  private readonly logger = new Logger(ReadabilityService.name);
  private readonly fetchLimiter = new ConcurrencyLimiter(MAX_CONCURRENT_FETCHES);

  constructor(
    private readonly http: HttpService,
    private readonly webSearchService: WebSearchService,
    private readonly rateLimiter: WebSearchRateLimiterService,
    @InjectModel(WebFetchCache.name)
    private readonly cacheModel: Model<WebFetchCacheDocument>,
  ) {}

  async fetch(input: WebFetchQuery): Promise<WebFetchResponse> {
    if (!(await this.webSearchService.isEnabled())) {
      throw new BadRequestException('Web search is disabled');
    }

    const rawUrl = (input.url ?? '').trim();
    if (!rawUrl) throw new BadRequestException('URL must not be empty');
    const maxLength = Math.max(1, Math.min(input.maxLength ?? DEFAULT_MAX_LENGTH, 200_000));

    const normalizedUrl = this.validateAndNormalizeUrl(rawUrl);
    const cacheKey = this.hashUrl(normalizedUrl, input.raw === true, maxLength);

    const cached = await this.cacheModel.findOne({ urlHash: cacheKey }).lean().exec();
    const fromCache = cached ? readCachedWebFetchResponse(cached.payload) : undefined;
    if (fromCache) return fromCache;

    // Rate-limit only on cache miss — cached responses are free.
    this.rateLimiter.consume('fetch');

    const { body, finalUrl, contentType } = await this.fetchLimiter.run(() =>
      this.safeFetch(normalizedUrl),
    );

    let response: WebFetchResponse;

    if (input.raw === true) {
      const text = body.slice(0, maxLength);
      response = {
        title: '',
        content: text,
        url: finalUrl,
        cached: false,
        contentLength: text.length,
        contentType,
      };
    } else if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      throw new BadRequestException(
        `Content-Type ${contentType} is not supported by the Readability extractor. Use raw=true for plain text, or attachment tools for PDFs/binaries.`,
      );
    } else {
      response = this.extractReadable(body, finalUrl, maxLength, contentType);
    }

    const ttlDays = await this.webSearchService.getContentCacheTtlDays();
    const expiresAt = new Date(Date.now() + ttlDays * 86400 * 1000);
    this.cacheModel
      .updateOne(
        { urlHash: cacheKey },
        { $set: { urlHash: cacheKey, url: normalizedUrl, payload: { ...response, cached: false }, expiresAt } },
        { upsert: true },
      )
      .exec()
      .catch((err: unknown) => this.logger.warn(`fetch cache write failed: ${errorMessage(err)}`));

    return response;
  }

  async stats(): Promise<{ cached: number; oldestEntry?: Date }> {
    const [count, oldest] = await Promise.all([
      this.cacheModel.countDocuments().exec(),
      this.cacheModel.findOne().sort({ createdAt: 1 }).lean<{ createdAt?: Date }>().exec(),
    ]);
    return { cached: count, oldestEntry: oldest?.createdAt };
  }

  async clearCache(): Promise<{ deleted: number }> {
    const res = await this.cacheModel.deleteMany({}).exec();
    return { deleted: res.deletedCount ?? 0 };
  }

  private validateAndNormalizeUrl(input: string): string {
    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      throw new BadRequestException('Invalid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('Only http:// and https:// URLs are allowed');
    }
    if (!parsed.hostname) {
      throw new BadRequestException('URL must include a hostname');
    }
    return parsed.toString();
  }

  /**
   * Fetches a URL with full SSRF protection:
   * - Resolves DNS on every hop and rejects private/link-local/loopback targets (defeats DNS rebinding)
   * - Follows redirects manually, re-validating each hop
   * - Size- and time-bounded
   */
  private async safeFetch(
    startUrl: string,
    redirectDepth = 0,
  ): Promise<{ body: string; finalUrl: string; contentType?: string }> {
    if (redirectDepth > MAX_REDIRECTS) {
      throw new BadRequestException('Too many redirects');
    }

    const url = new URL(startUrl);
    await this.assertPublicHost(url.hostname);

    let res;
    try {
      res = await this.http.axiosRef.get(url.toString(), {
        timeout: FETCH_TIMEOUT_MS,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_RESPONSE_BYTES,
        maxRedirects: 0,
        responseType: 'text',
        validateStatus: () => true,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.1',
          'Accept-Language': 'de,en;q=0.8',
        },
      });
    } catch (err: unknown) {
      if (isAxiosError(err) && err.code === 'ECONNABORTED') {
        throw new ServiceUnavailableException('Fetch timeout');
      }
      throw new ServiceUnavailableException(`Fetch failed: ${errorMessage(err)}`);
    }

    // Redirect — manually re-validate the next hop. `headers` ist bei axios über
    // eine Index-Signatur `any` getypt; der Wert wird deshalb als `unknown`
    // gelesen und geprüft, statt ihn als String zu behaupten.
    const location: unknown = res.headers.location;
    if (res.status >= 300 && res.status < 400 && typeof location === 'string' && location) {
      const next = new URL(location, url).toString();
      return this.safeFetch(next, redirectDepth + 1);
    }

    if (res.status >= 400) {
      throw new ServiceUnavailableException(`Upstream returned HTTP ${res.status}`);
    }

    const body = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    const rawContentType: unknown = res.headers['content-type'];
    const contentType =
      typeof rawContentType === 'string'
        ? rawContentType.split(';')[0]?.trim().toLowerCase()
        : undefined;
    return { body, finalUrl: url.toString(), contentType };
  }

  private async assertPublicHost(hostname: string): Promise<void> {
    const stripped = hostname.replace(/^\[|\]$/g, '');

    // Already an IP literal — validate it directly
    if (isIP(stripped)) {
      if (this.isPrivateIp(stripped)) {
        throw new ForbiddenException('Request to private/reserved IP is not allowed');
      }
      return;
    }

    // Block obvious local hostnames before DNS
    const lower = hostname.toLowerCase();
    if (
      lower === 'localhost' ||
      lower.endsWith('.localhost') ||
      lower.endsWith('.local') ||
      lower.endsWith('.internal')
    ) {
      throw new ForbiddenException(`Hostname ${hostname} resolves to a private network`);
    }

    let resolved: Array<{ address: string; family: number }>;
    try {
      resolved = await lookup(hostname, { all: true });
    } catch {
      throw new ServiceUnavailableException(`DNS resolution failed for ${hostname}`);
    }

    for (const { address } of resolved) {
      if (this.isPrivateIp(address)) {
        throw new ForbiddenException(`Hostname ${hostname} resolves to a private IP (${address})`);
      }
    }
  }

  /**
   * RFC 1918 (10/8, 172.16/12, 192.168/16), loopback (127/8, ::1),
   * link-local (169.254/16, fe80::/10), unspecified (0.0.0.0, ::),
   * carrier-grade NAT (100.64/10), IPv6 ULA (fc00::/7), multicast.
   */
  private isPrivateIp(ip: string): boolean {
    const v = isIP(ip);
    if (v === 4) {
      const parts = ip.split('.').map((n) => parseInt(n, 10));
      const [a, b] = parts;
      if (a === 10) return true;
      if (a === 127) return true;
      if (a === 0) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;
      if (a >= 224) return true; // multicast + reserved
      return false;
    }
    if (v === 6) {
      const lower = ip.toLowerCase();
      if (lower === '::' || lower === '::1') return true;
      if (lower.startsWith('fe80:') || lower.startsWith('fe90:') || lower.startsWith('fea0:') || lower.startsWith('feb0:')) return true;
      // fc00::/7 → fc.. or fd..
      if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
      if (lower.startsWith('ff')) return true; // multicast
      // IPv4-mapped ::ffff:x.x.x.x — recheck mapped address
      const mapped = lower.match(/::ffff:([\d.]+)$/);
      if (mapped && isIP(mapped[1]) === 4) return this.isPrivateIp(mapped[1]);
      return false;
    }
    return true; // unknown → safer to reject
  }

  private extractReadable(html: string, url: string, maxLength: number, contentType?: string): WebFetchResponse {
    try {
      const dom = new JSDOM(html, { url });
      const doc = dom.window.document;
      const reader = new Readability(doc);
      const article = reader.parse();
      if (!article) {
        throw new BadRequestException('Readability could not extract any content from this page');
      }
      // Hier stand ein `DOMPurify.sanitize(article.content …)`, dessen Ergebnis
      // in einer Variablen landete und nie gelesen wurde: die Antwort enthält
      // ausschließlich `article.textContent` (Klartext), kein HTML-Feld. Der
      // Aufruf hat also nichts geschützt — er sah nur so aus. Entfernt statt
      // scheinbar benutzt; wer HTML ausliefern will, braucht ein eigenes Feld
      // *und* dann diese Bereinigung.
      const text = (article.textContent ?? '').trim().slice(0, maxLength);
      return {
        title: article.title ?? '',
        siteName: article.siteName ?? undefined,
        content: text,
        excerpt: article.excerpt ?? undefined,
        publishedDate: article.publishedTime ?? undefined,
        url,
        cached: false,
        contentLength: text.length,
        contentType,
      };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Readability extraction failed: ${msg}`);
    }
  }

  private hashUrl(url: string, raw: boolean, maxLength: number): string {
    return createHash('sha256')
      .update(`${raw ? 'raw' : 'readable'}|${maxLength}|${url}`)
      .digest('hex');
  }
}
