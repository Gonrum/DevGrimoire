import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, Job } from 'bullmq';
import { BALANCER_QUEUE, GatewayJobData, ZERO_USAGE } from './balancer.types';
import { EndpointAllocator } from './endpoint-allocator.service';
import { LlmEndpointsService } from './llm-endpoints.service';
import { LlmClient } from './llm-client.service';
import { LlmHealthService } from './llm-health.service';
import { LlmUsageService } from './llm-usage.service';
import { StreamRelay } from './stream-relay.service';

@Processor(BALANCER_QUEUE, { concurrency: 16 })
export class GatewayProcessor extends WorkerHost {
  constructor(
    private readonly allocator: EndpointAllocator,
    private readonly endpoints: LlmEndpointsService,
    private readonly client: LlmClient,
    private readonly health: LlmHealthService,
    private readonly usage: LlmUsageService,
    private readonly relay: StreamRelay,
  ) { super(); }

  async process(job: Job<GatewayJobData>): Promise<void> {
    const jobId = String(job.id);
    const { purpose, requireVision } = job.data;
    const slot = await this.allocator.acquire(purpose, { requireVision });
    if (!slot) {
      await job.moveToDelayed(Date.now() + 2000, (job as unknown as { token: string }).token);
      throw new DelayedError();
    }
    const startedAt = Date.now();
    try {
      const apiKey = await this.endpoints.getDecryptedApiKey(slot.id);
      if (purpose === 'embedding') {
        const text = String(job.data.payload.text ?? '');
        const embedding = await this.client.embed({
          provider: slot.provider, baseUrl: slot.baseUrl, model: slot.model, apiKey,
          text, timeoutMs: slot.timeoutMs,
        });
        this.health.recordSuccess(slot.id);
        this.relay.publish(jobId, { type: 'result', data: { embedding }, usage: { ...ZERO_USAGE } });
        await this.usage.record({
          purpose, endpointId: slot.id, model: slot.model,
          ...ZERO_USAGE,
          durationMs: Date.now() - startedAt, status: 'ok',
        });
        return;
      }
      // chat/workflow branches added in Task 12/13
      throw new Error(`purpose_not_implemented:${purpose}`);
    } catch (err) {
      this.health.recordFailure(slot.id);
      this.relay.publish(jobId, { type: 'error', status: 502, message: (err as Error).message });
      await this.usage.record({
        purpose, endpointId: slot.id, model: slot.model,
        ...ZERO_USAGE,
        durationMs: Date.now() - startedAt, status: 'error', error: (err as Error).message,
      });
    } finally {
      this.allocator.release(slot.id);
    }
  }
}
