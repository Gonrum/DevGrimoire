import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job } from 'bullmq';
import { BALANCER_QUEUE, GatewayJobData, ZERO_USAGE } from './balancer.types';
import { EndpointAllocator } from './endpoint-allocator.service';
import { LlmEndpointsService } from './llm-endpoints.service';
import { LlmClient } from './llm-client.service';
import { LlmHealthService } from './llm-health.service';
import { LlmUsageService } from './llm-usage.service';
import { StreamRelay } from './stream-relay.service';
import { ChatRunner, hasCommittedOutput, readChatJobPayload } from './chat-runner.service';
import { errorMessage } from '../common/narrow';

@Processor(BALANCER_QUEUE, { concurrency: 16 })
export class GatewayProcessor extends WorkerHost {
  constructor(
    private readonly allocator: EndpointAllocator,
    private readonly endpoints: LlmEndpointsService,
    private readonly client: LlmClient,
    private readonly health: LlmHealthService,
    private readonly usage: LlmUsageService,
    private readonly relay: StreamRelay,
    private readonly chatRunner: ChatRunner,
  ) { super(); }

  private readonly logger = new Logger(GatewayProcessor.name);

  /** Persist a usage record without ever letting a monitoring-write failure escape into the request/health path. */
  private async safeRecord(rec: Parameters<LlmUsageService['record']>[0]): Promise<void> {
    try {
      await this.usage.record(rec);
    } catch (err: unknown) {
      this.logger.warn(`usage.record failed (non-fatal): ${errorMessage(err)}`);
    }
  }

  async process(job: Job<GatewayJobData>): Promise<void> {
    const jobId = String(job.id);
    const { purpose, requireVision } = job.data;
    // BullMQ setzt `job.token` vor dem Aufruf (`Worker.processJob`) und
    // deklariert das Feld inzwischen auch — der `as unknown as { token: string }`
    // hier war die Umgehung einer älteren Typdatei.
    const token = job.token;
    const tried = new Set<string>();
    let lastErrMessage: string | null = null;

    for (;;) {
      const slot = await this.allocator.acquire(purpose, { requireVision, exclude: tried });
      if (!slot) {
        if (tried.size === 0) {
          // Nothing free & healthy right now (all busy / unhealthy / none) → wait, never drop.
          await job.moveToDelayed(Date.now() + 2000, token);
          throw new DelayedError();
        }
        break; // Tried every free healthy endpoint this request; all failed.
      }
      const startedAt = Date.now();
      try {
        const apiKey = await this.endpoints.getDecryptedApiKey(slot.id);
        if (purpose === 'embedding') {
          // Payload-Feld aus Redis-JSON: `String(unknown)` hätte für ein Objekt
          // "[object Object]" eingebettet statt den Job scheitern zu lassen.
          const raw = job.data.payload.text;
          const text = typeof raw === 'string' ? raw : '';
          const embedding = await this.client.embed({
            provider: slot.provider, baseUrl: slot.baseUrl, model: slot.model, apiKey,
            text, timeoutMs: slot.timeoutMs,
          });
          this.relay.publish(jobId, { type: 'result', data: { embedding }, usage: { ...ZERO_USAGE } });
        } else if (purpose === 'chat') {
          // The runner streams one turn and relays each event (and the terminal
          // `done`) itself; tool execution stays in the chat controller loop.
          await this.chatRunner.run(jobId, slot, apiKey, readChatJobPayload(job.data.payload));
        } else {
          // workflow branch added in Task 13
          throw new Error(`purpose_not_implemented:${purpose}`);
        }
        this.health.recordSuccess(slot.id);
        await this.safeRecord({
          purpose, endpointId: slot.id, model: slot.model,
          ...ZERO_USAGE,
          durationMs: Date.now() - startedAt, status: 'ok',
        });
        this.allocator.release(slot.id);
        return;
      } catch (err: unknown) {
        this.allocator.release(slot.id);
        this.health.recordFailure(slot.id);
        lastErrMessage = errorMessage(err);
        await this.safeRecord({
          purpose, endpointId: slot.id, model: slot.model,
          ...ZERO_USAGE,
          durationMs: Date.now() - startedAt, status: 'error', error: lastErrMessage,
        });
        // Chat that already streamed tokens can't be retried elsewhere (would
        // duplicate output). Embed is atomic → always retriable.
        if (hasCommittedOutput(err)) {
          this.relay.publish(jobId, { type: 'error', status: 502, message: lastErrMessage });
          return;
        }
        tried.add(slot.id);
        // loop → next free healthy endpoint
      }
    }
    this.relay.publish(jobId, {
      type: 'error', status: 502,
      message: lastErrMessage ?? `all ${purpose} endpoints failed`,
    });
  }
}
