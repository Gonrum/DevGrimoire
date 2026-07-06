import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BALANCER_QUEUE, GatewayJobData, PURPOSE_PRIORITY } from './balancer.types';

@Injectable()
export class LlmQueueService {
  constructor(@InjectQueue(BALANCER_QUEUE) private readonly queue: Queue) {}

  async enqueue(data: GatewayJobData): Promise<string> {
    const job = await this.queue.add('request', data, {
      priority: PURPOSE_PRIORITY[data.purpose],
      removeOnComplete: 200,
      removeOnFail: { age: 7 * 24 * 3600, count: 20_000 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 15_000 },
    });
    return String(job.id);
  }
}
