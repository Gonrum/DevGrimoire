import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';

@Injectable()
export class ActionUserQuestionExecutor implements NodeExecutor {
  readonly type = 'action.user-question';
  readonly metadata: NodeMetadata = {
    type: 'action.user-question',
    category: 'action',
    label: 'Rückfrage an User',
    description: 'Erzeugt eine Question und wartet auf die Antwort. Optional Branch-Mapping pro Option.',
    allowedScopes: [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      question: z.string().min(1),
      options: z.array(z.string()).optional(),
      branchMap: z.record(z.enum(['success', 'failure', 'custom'])).optional(),
      timeoutSeconds: z.number().int().positive().optional(),
    }),
    outputs: { answer: 'string', optionIndex: 'number|null' },
    branches: ['success', 'failure', 'custom'],
  };

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const question = String(ctx.config.question ?? '').trim();
    const options = (ctx.config.options as string[] | undefined) ?? [];
    if (!question) {
      return { status: 'failed', error: { code: 'invalid_config', message: 'question required' } };
    }
    const { refId } = await ctx.askUser(question, options);
    return { status: 'waiting', waitingFor: { type: 'question', refId } };
  }
}
