import { Injectable } from '@nestjs/common';
import { firstValueFrom, filter, timeout } from 'rxjs';
import { LlmQueueService } from './llm-queue.service';
import { StreamRelay } from './stream-relay.service';
import { RelayEvent } from './balancer.types';
import type { ChatStreamEvent, OpenAiToolDef } from '../chat/chat-llm.service';

/** Input for a single chat turn routed through the balancer queue. */
export interface ChatRunInput {
  withTools: boolean;
  messages: unknown[];
  tools?: OpenAiToolDef[];
  temperature: number;
  maxTokens: number;
  images?: { data: string; mediaType: string }[];
  requireVision?: boolean;
  signal?: AbortSignal;
  /**
   * Reserved for future endpoint-attribution reporting. Endpoint selection
   * happens inside the worker (allocator), so this is currently NOT invoked;
   * chat-activity logging loses the exact endpoint under the balancer path.
   */
  onEndpointSelected?: (endpoint: { provider: string; url: string; model: string }) => void;
}

@Injectable()
export class BalancerGateway {
  constructor(private readonly queue: LlmQueueService, private readonly relay: StreamRelay) {}

  async runEmbed(input: { text: string }): Promise<number[]> {
    const jobId = await this.queue.enqueue({ purpose: 'embedding', stream: false, payload: { text: input.text } });
    const waitMs = Number(process.env.POOL_WAIT_TIMEOUT_MS || 120_000);
    const ev = await firstValueFrom(
      this.relay.subscribe(jobId).pipe(
        filter((e: RelayEvent) => e.type === 'result' || e.type === 'error'),
        timeout(waitMs),
      ),
    );
    if (ev.type === 'error') throw new Error(ev.message);
    return (ev.data.embedding as number[]) ?? [];
  }

  /**
   * Route ONE chat turn through the queue and stream its events back as an
   * async iterable. Enqueues a `chat` job; a worker leases a chat-pool slot,
   * streams the turn via `LlmClient`, and publishes `chat_event`/`done`/`error`
   * relay events which we bridge here.
   *
   * Bridge: the `StreamRelay` subject is a `ReplaySubject`, so events published
   * before we subscribe are replayed (no lost-update race between enqueue and
   * subscribe). We drain it with a buffered push pattern — the RxJS `next`
   * callback pushes into a buffer and wakes a pending resolver; this generator
   * awaits that resolver whenever the buffer is empty.
   *
   * Cancellation: if `input.signal` aborts (client disconnect) we call
   * `relay.cancel(jobId)`, which the worker checks between chunks to stop
   * iterating. If the consumer breaks early (before `done`/`error`), the
   * `finally` also cancels so the worker doesn't keep streaming into the void.
   */
  async *runChat(input: ChatRunInput): AsyncIterable<ChatStreamEvent> {
    const jobId = await this.queue.enqueue({
      purpose: 'chat',
      stream: true,
      payload: {
        withTools: input.withTools,
        messages: input.messages,
        tools: input.tools,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        images: input.images,
      },
      requireVision: input.requireVision,
    });

    const onAbort = () => this.relay.cancel(jobId);
    if (input.signal) {
      if (input.signal.aborted) this.relay.cancel(jobId);
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Observable → AsyncIterable bridge (buffered push).
    const buffer: RelayEvent[] = [];
    let wake: (() => void) | null = null;
    let completed = false;
    let observableError: Error | null = null;

    const wakeUp = (): void => {
      if (wake) { const w = wake; wake = null; w(); }
    };

    const sub = this.relay.subscribe(jobId).subscribe({
      next: (ev) => { buffer.push(ev); wakeUp(); },
      error: (err) => { observableError = err instanceof Error ? err : new Error(String(err)); wakeUp(); },
      complete: () => { completed = true; wakeUp(); },
    });

    let endedNormally = false;
    try {
      while (true) {
        if (buffer.length === 0) {
          if (observableError) throw observableError;
          if (completed) { endedNormally = true; return; }
          await new Promise<void>((resolve) => { wake = resolve; });
          continue;
        }
        const ev = buffer.shift() as RelayEvent;
        if (ev.type === 'chat_event') {
          yield ev.event as unknown as ChatStreamEvent;
        } else if (ev.type === 'done') {
          endedNormally = true;
          return;
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
        // 'result' / 'cancel' — not expected on the chat path; ignore.
      }
    } finally {
      sub.unsubscribe();
      if (input.signal) input.signal.removeEventListener('abort', onAbort);
      // Consumer broke early (no done/error) → tell the worker to stop streaming.
      if (!endedNormally) this.relay.cancel(jobId);
    }
  }
}
