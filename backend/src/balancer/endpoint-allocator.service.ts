import { Injectable } from '@nestjs/common';
import { LlmEndpointsService } from './llm-endpoints.service';
import { LlmHealthService } from './llm-health.service';
import { LlmPurpose, Slot } from './balancer.types';

@Injectable()
export class EndpointAllocator {
  private readonly inUse = new Map<string, number>();

  constructor(
    private readonly endpoints: LlmEndpointsService,
    private readonly health: LlmHealthService,
  ) {}

  async acquire(purpose: LlmPurpose, filter?: { requireVision?: boolean }): Promise<Slot | null> {
    const pool = await this.endpoints.listForPool(purpose, filter); // priority asc
    for (const e of pool) {
      if (!this.health.isHealthy(e.id)) continue;
      const used = this.inUse.get(e.id) ?? 0;
      if (used < e.concurrency) {
        this.inUse.set(e.id, used + 1);
        return { id: e.id, provider: e.provider, baseUrl: e.baseUrl, model: e.model, timeoutMs: e.timeoutMs };
      }
    }
    return null;
  }

  release(id: string): void {
    const used = this.inUse.get(id) ?? 0;
    if (used > 0) this.inUse.set(id, used - 1);
  }

  inFlight(id: string): number { return this.inUse.get(id) ?? 0; }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, n] of this.inUse) if (n > 0) out[id] = n;
    return out;
  }

  async poolCapacity(purpose: LlmPurpose, filter?: { requireVision?: boolean }): Promise<number> {
    const pool = await this.endpoints.listForPool(purpose, filter);
    return pool.filter((e) => this.health.isHealthy(e.id)).reduce((sum, e) => sum + e.concurrency, 0);
  }

  async totalCapacity(): Promise<number> {
    const purposes: LlmPurpose[] = ['chat', 'embedding', 'workflow'];
    let total = 0;
    for (const p of purposes) total += await this.poolCapacity(p);
    // Endpoints serving multiple purposes are double-counted here; that only
    // inflates the worker pool size, which is a safe upper bound.
    return Math.max(1, total);
  }
}
