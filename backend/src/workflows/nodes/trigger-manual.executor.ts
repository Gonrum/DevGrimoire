import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';

@Injectable()
export class TriggerManualExecutor implements NodeExecutor {
  readonly type = 'trigger.manual';
  async execute(_ctx: NodeExecutionContext): Promise<NodeResult> {
    return { status: 'success', output: {} };
  }
}
