import { Controller, Get } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/schemas/user.schema';
import { EndpointAllocator } from './endpoint-allocator.service';
import { LlmHealthService } from './llm-health.service';
import { LlmEndpointsService } from './llm-endpoints.service';
import { LlmUsageService } from './llm-usage.service';
import { BALANCER_QUEUE, LLM_PURPOSES } from './balancer.types';

/**
 * Read-only monitor for the LLM balancer: pool capacity, per-endpoint
 * health/in-flight load, BullMQ queue depth and usage stats. Admin-only —
 * this exposes internal routing/capacity info, not something a regular
 * caller needs, matching the full-lockdown convention of
 * llm-endpoints.controller.ts.
 */
@Controller('balancer')
export class BalancerController {
  constructor(
    private readonly allocator: EndpointAllocator,
    private readonly health: LlmHealthService,
    private readonly endpoints: LlmEndpointsService,
    private readonly usage: LlmUsageService,
    @InjectQueue(BALANCER_QUEUE) private readonly queue: Queue,
  ) {}

  @Get('status')
  @Roles(UserRole.ADMIN)
  async status() {
    const [endpointList, jobCounts, usageSummary, byPurpose] = await Promise.all([
      this.endpoints.list(),
      this.queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed'),
      this.usage.summary(),
      this.jobsByPurpose(),
    ]);

    const inFlight = this.allocator.snapshot();

    const pools = await Promise.all(
      LLM_PURPOSES.map(async (purpose) => ({
        purpose,
        capacity: await this.allocator.poolCapacity(purpose),
        waiting: byPurpose.waiting[purpose] ?? 0,
        active: byPurpose.active[purpose] ?? 0,
      })),
    );

    const endpointStatus = endpointList.map((e) => ({
      id: e.id,
      label: e.label,
      purposes: e.purposes,
      enabled: e.enabled,
      concurrency: e.concurrency,
      inFlight: inFlight[e.id] ?? 0,
      healthy: this.health.isHealthy(e.id),
    }));

    return {
      pools,
      endpoints: endpointStatus,
      queue: jobCounts,
      usage: usageSummary,
    };
  }

  /** Group currently waiting/active BullMQ jobs by purpose for the per-pool breakdown. */
  private async jobsByPurpose(): Promise<{ waiting: Record<string, number>; active: Record<string, number> }> {
    const [waitingJobs, activeJobs] = await Promise.all([
      this.queue.getJobs(['waiting'], 0, -1),
      this.queue.getJobs(['active'], 0, -1),
    ]);
    const count = (jobs: Array<{ data?: { purpose?: string } }>): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const j of jobs) {
        const p = j.data?.purpose;
        if (p) out[p] = (out[p] ?? 0) + 1;
      }
      return out;
    };
    return { waiting: count(waitingJobs), active: count(activeJobs) };
  }
}
