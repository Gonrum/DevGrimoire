import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';

@Injectable()
export class TriggerScheduleExecutor implements NodeExecutor {
  readonly type = 'trigger.schedule';
  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const slot = ctx.run.triggeredBy?.scheduleSlotAt;
    return {
      status: 'success',
      output: { scheduleSlotAt: slot?.toISOString?.() ?? null },
    };
  }
}
