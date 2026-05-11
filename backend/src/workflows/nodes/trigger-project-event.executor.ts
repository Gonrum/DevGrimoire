import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';

const entityEnum = z.enum([
  'project', 'todo', 'session', 'knowledge', 'changelog', 'milestone', 'manual', 'research',
  'notification', 'environment', 'secret', 'schema', 'dependency', 'feature', 'soul',
  'commit', 'recurring-task', 'snippet', 'attachment', 'log', 'release', 'chat',
  'workspace', 'customer-project', 'contact', 'customer', 'healthcheck',
  'workflow-definition', 'workflow-run', '*',
]);
const actionEnum = z.enum(['created', 'updated', 'deleted', '*']);

@Injectable()
export class TriggerProjectEventExecutor implements NodeExecutor {
  readonly type = 'trigger.project_event';
  readonly metadata: NodeMetadata = {
    type: 'trigger.project_event',
    category: 'trigger',
    label: 'Projekt-Event-Trigger',
    description: 'Workflow startet, wenn ein Projekt-Event (Entity-Mutation) matched.',
    allowedScopes: [WorkflowScope.PROJECT],
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

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const input = (ctx.runContext as { input?: { event?: unknown } }).input;
    return { status: 'success', output: { event: input?.event ?? null } };
  }
}
