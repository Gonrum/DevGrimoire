import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';

@Injectable()
export class TriggerScheduleExecutor implements NodeExecutor {
  readonly type = 'trigger.schedule';
  readonly metadata: NodeMetadata = {
    type: 'trigger.schedule',
    category: 'trigger',
    label: 'Schedule-Trigger',
    description: 'Workflow startet zu festgelegten Zeiten (Cron/Intervall). Schedule-Konfiguration liegt am Workflow-Trigger, nicht am Node.',
    allowedScopes: [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({}).strict(),
    outputs: { scheduleSlotAt: 'string|null' },
    branches: ['success'],
  };
  // Kein `async`: der Node liest nur ein Feld aus dem Run.
  execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const slot = ctx.run.triggeredBy?.scheduleSlotAt;
    return Promise.resolve({
      status: 'success',
      output: { scheduleSlotAt: slot?.toISOString?.() ?? null },
    });
  }
}
