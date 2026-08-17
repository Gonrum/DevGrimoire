import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { isRecord } from '../workflow-narrow';

const entityEnum = z.enum([
  'project', 'todo', 'session', 'knowledge', 'changelog', 'milestone', 'manual', 'research',
  'notification', 'environment', 'secret', 'schema', 'dependency', 'feature', 'soul',
  'commit', 'recurring-task', 'snippet', 'attachment', 'log', 'release', 'chat',
  'workspace', 'customer-project', 'contact', 'customer', 'healthcheck',
  'workflow-definition', 'workflow-run', '*',
]);
const actionEnum = z.enum(['created', 'updated', 'deleted', '*']);

@Injectable()
export class TriggerCustomerEventExecutor implements NodeExecutor {
  readonly type = 'trigger.customer_event';
  readonly metadata: NodeMetadata = {
    type: 'trigger.customer_event',
    category: 'trigger',
    label: 'Kunden-Event-Trigger',
    description: 'Workflow startet, wenn ein Customer-Event (Entity-Mutation) matched. Hinweis: filter.tag/status/milestoneId werden zur Trigger-Zeit NICHT angewendet — sie sind reservierte Felder; präzise Filterung erfolgt im nachgelagerten control.condition-Node basierend auf {{input.event.*}}.',
    allowedScopes: [WorkflowScope.CUSTOMER],
    configSchema: z.object({
      entity: entityEnum,
      action: actionEnum,
      filter: z.object({
        tag: z.string().optional(),
        status: z.string().optional(),
        milestoneId: z.string().optional(),
      }).optional(),
    }),
    outputs: { event: 'object' },
    branches: ['success'],
  };

  // Kein `async`: der Trigger gibt nur den Event aus dem Run-Input zurück.
  execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const input = ctx.runContext.input;
    const event = isRecord(input) ? input.event : undefined;
    return Promise.resolve({ status: 'success', output: { event: event ?? null } });
  }
}
