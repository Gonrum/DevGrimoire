import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';

@Injectable()
export class TriggerManualExecutor implements NodeExecutor {
  readonly type = 'trigger.manual';
  readonly metadata: NodeMetadata = {
    type: 'trigger.manual',
    category: 'trigger',
    label: 'Manueller Trigger',
    description: 'Workflow startet, wenn ein User oder Agent ihn manuell auslöst.',
    allowedScopes: [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({}).strict(),
    outputs: {},
    branches: ['success'],
  };
  async execute(_ctx: NodeExecutionContext): Promise<NodeResult> {
    return { status: 'success', output: {} };
  }
}
