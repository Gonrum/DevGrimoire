import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { RequestContext } from '../../common/request-context';

export type RateLimitKind = 'search' | 'fetch';

interface Bucket {
  count: number;
  windowEndsAt: number;
}

const WINDOW_MS = 60_000;
const SEARCH_LIMIT = 30;
const FETCH_LIMIT = 20;
const ANONYMOUS_KEY = '__anon__';
const CLEANUP_THRESHOLD = 1000;

@Injectable()
export class WebSearchRateLimiterService {
  private readonly logger = new Logger(WebSearchRateLimiterService.name);
  private readonly buckets = new Map<string, Bucket>();

  consume(kind: RateLimitKind): void {
    const userId = RequestContext.getUser()?.userId ?? process.env.MCP_STDIO_USER_ID ?? ANONYMOUS_KEY;
    const limit = kind === 'search' ? SEARCH_LIMIT : FETCH_LIMIT;
    const key = `${kind}:${userId}`;
    const now = Date.now();

    let bucket = this.buckets.get(key);
    if (!bucket || bucket.windowEndsAt <= now) {
      bucket = { count: 0, windowEndsAt: now + WINDOW_MS };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.windowEndsAt - now) / 1000));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Rate limit exceeded for ${kind} (${limit}/min). Retry after ${retryAfterSec}s.`,
          retryAfter: retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (this.buckets.size > CLEANUP_THRESHOLD) {
      this.evictExpired(now);
    }
  }

  /** Test/debug helper — returns current count for a (kind, userId) tuple. */
  inspect(kind: RateLimitKind, userId: string): { count: number; remaining: number } {
    const key = `${kind}:${userId}`;
    const bucket = this.buckets.get(key);
    const limit = kind === 'search' ? SEARCH_LIMIT : FETCH_LIMIT;
    if (!bucket || bucket.windowEndsAt <= Date.now()) {
      return { count: 0, remaining: limit };
    }
    return { count: bucket.count, remaining: Math.max(0, limit - bucket.count) };
  }

  private evictExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowEndsAt <= now) this.buckets.delete(key);
    }
  }
}
