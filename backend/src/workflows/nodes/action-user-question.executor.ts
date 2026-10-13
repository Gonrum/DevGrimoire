import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { asString } from '../../common/tool-args';
import { asStringArray } from '../workflow-narrow';

/** Ohne `timeoutSeconds` wartet eine Workflow-Frage einen Tag (M-31). */
export const WORKFLOW_QUESTION_DEFAULT_TIMEOUT_SECONDS = 24 * 3600;

@Injectable()
export class ActionUserQuestionExecutor implements NodeExecutor {
  readonly type = 'action.user-question';
  readonly metadata: NodeMetadata = {
    type: 'action.user-question',
    category: 'action',
    label: 'Rückfrage an User',
    description: 'Erzeugt eine Question und wartet auf die Antwort. Optional Branch-Mapping pro Option. Ohne Antwort bis timeoutSeconds (Default 24 h) scheitert der Knoten mit question_timeout.',
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
    const question = (asString(ctx.config.question) ?? '').trim();
    const options = asStringArray(ctx.config.options) ?? [];
    if (!question) {
      return { status: 'failed', error: { code: 'invalid_config', message: 'question required' } };
    }
    // M-31: timeoutSeconds wurde validiert und dokumentiert, aber nie
    // weitergereicht — jede Workflow-Frage lief nach dem Questions-Default von
    // 5 min ab, während der Run unbegrenzt weiterwartete.
    const timeoutSeconds = typeof ctx.config.timeoutSeconds === 'number' && Number.isInteger(ctx.config.timeoutSeconds)
      && ctx.config.timeoutSeconds > 0
      ? ctx.config.timeoutSeconds
      : WORKFLOW_QUESTION_DEFAULT_TIMEOUT_SECONDS;
    const { refId } = await ctx.askUser(question, options, { timeoutSeconds });
    return { status: 'waiting', waitingFor: { type: 'question', refId } };
  }
}
