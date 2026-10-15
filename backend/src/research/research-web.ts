import { Injectable } from '@nestjs/common';
import { isNullaryMethod, isRecord } from '../common/tool-args';
import { ReadabilityService } from '../web-search/services/readability.service';
import { WebSearchService } from '../web-search/services/web-search.service';
import { TASK_LIMITS } from './research-config';
import { Interrupted } from './research-llm.service';

export interface WebHit { title: string; url: string; snippet: string }
export interface WebPage { url: string; title: string; text: string }

const MAX_WAIT_S = 65;

/** Liefert die Wartezeit in Sekunden, wenn der Fehler ein 429 des Rate-Limiters ist. */
function retryAfterOf(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;
  const getStatus = err.getStatus;
  if (!isNullaryMethod(getStatus) || getStatus.call(err) !== 429) return undefined;
  const getResponse = err.getResponse;
  const body: unknown = isNullaryMethod(getResponse) ? getResponse.call(err) : undefined;
  const retry = isRecord(body) && typeof body.retryAfter === 'number' && body.retryAfter >= 0 ? body.retryAfter : 0;
  return Math.min(retry, MAX_WAIT_S);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Interrupted('Recherche unterbrochen')); return; }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Interrupted('Recherche unterbrochen'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Suche und Seitenabruf mit einem Wiederholungsversuch nach Rate-Limit (429). */
@Injectable()
export class ResearchWeb {
  constructor(
    private readonly searcher: Pick<WebSearchService, 'search'>,
    private readonly readability: Pick<ReadabilityService, 'fetch'>,
  ) {}

  private async withRetry<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const wait = retryAfterOf(err);
      if (wait === undefined) throw err;
      await sleep(wait * 1000, signal);
      return fn();
    }
  }

  async search(query: string, signal: AbortSignal): Promise<WebHit[]> {
    const res = await this.withRetry(signal, () => this.searcher.search({ query, limit: TASK_LIMITS.searchHits }));
    return res.results.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet }));
  }

  async fetch(url: string, maxChars: number, signal: AbortSignal): Promise<WebPage> {
    const res = await this.withRetry(signal, () => this.readability.fetch({ url, maxLength: maxChars }));
    return { url: res.url || url, title: res.title, text: res.content };
  }
}
