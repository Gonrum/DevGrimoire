import { Injectable } from '@nestjs/common';
import { firstValueFrom, filter, timeout } from 'rxjs';
import { LlmQueueService } from './llm-queue.service';
import { StreamRelay } from './stream-relay.service';
import { RelayEvent } from './balancer.types';

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
}
