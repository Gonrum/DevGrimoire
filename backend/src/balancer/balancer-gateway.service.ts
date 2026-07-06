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
   * Idle deadline: the empty-buffer wait also races an idle timer
   * (`POOL_WAIT_TIMEOUT_MS`, default 120s), re-armed on each wait. If NO relay
   * event arrives within the window — e.g. zero/unhealthy chat endpoints or a
   * `requireVision` request with no vision endpoint, where the processor
   * re-delays the job forever without emitting anything — the generator throws
   * instead of suspending forever, so the controller's `for await` unwinds and
   * its `finally` (heartbeat/subscription cleanup) runs. An active stream keeps
   * resetting the timer, so a long healthy turn is never killed.
   *
   * Cancellation: if `input.signal` aborts (client disconnect) we call
   * `relay.cancel(jobId)` AND wake the suspended generator so it returns (not
   * throws) and its `finally` runs promptly. The worker checks `relay.isCancelled`
   * between chunks to stop iterating. If the consumer breaks early (before
   * `done`/`error`), the `finally` also cancels so the worker stops streaming.
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

    // Bridge state.
    const buffer: RelayEvent[] = [];
    let wake: (() => void) | null = null;
    let completed = false;
    let observableError: Error | null = null;
    let aborted = false;

    const wakeUp = (): void => {
      if (wake) { const w = wake; wake = null; w(); }
    };

    // Client disconnect: cancel the job AND wake the (possibly suspended)
    // generator so its finally runs and the controller's for-await exits
    // promptly instead of hanging on the pending wait.
    const onAbort = (): void => { aborted = true; this.relay.cancel(jobId); wakeUp(); };
    if (input.signal) {
      if (input.signal.aborted) { aborted = true; this.relay.cancel(jobId); }
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }

    const sub = this.relay.subscribe(jobId).subscribe({
      next: (ev) => { buffer.push(ev); wakeUp(); },
      error: (err) => { observableError = err instanceof Error ? err : new Error(String(err)); wakeUp(); },
      complete: () => { completed = true; wakeUp(); },
    });

    const waitMs = Number(process.env.POOL_WAIT_TIMEOUT_MS || 120_000);
    let endedNormally = false;
    try {
      while (true) {
        // Client aborted → stop yielding and return normally (finally cancels + tears down).
        if (aborted) return;
        if (buffer.length === 0) {
          if (observableError) throw observableError;
          if (completed) { endedNormally = true; return; }
          // Wait for the next event, an abort, or an idle deadline. The timer is
          // an IDLE timeout (re-armed on every wait, cleared as soon as anything
          // wakes us), so a long but actively-streaming turn is never killed —
          // only a total stall (no endpoint available, all busy/unhealthy, so the
          // processor re-delays the job forever without ever emitting an event).
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          const outcome = await new Promise<'event' | 'timeout'>((resolve) => {
            wake = () => resolve('event');
            idleTimer = setTimeout(() => { wake = null; resolve('timeout'); }, waitMs);
            idleTimer.unref?.();
          });
          if (idleTimer) clearTimeout(idleTimer);
          if (outcome === 'timeout') {
            // A real event / completion / error / abort may have landed in the
            // SAME tick the idle timer fired (its callback nulled `wake` first,
            // so that wakeUp() no-op'd). Let real state win instead of spuriously
            // timing out — the loop top re-drains buffer / handles done/error/abort.
            if (buffer.length > 0 || completed || observableError || aborted) {
              continue;
            }
            throw new Error('chat pool wait timeout — no endpoint available or all busy/unhealthy');
          }
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
      // Idle-timeout, early consumer break, or abort (no done/error) → stop the worker.
      if (!endedNormally) this.relay.cancel(jobId);
    }
  }
}
