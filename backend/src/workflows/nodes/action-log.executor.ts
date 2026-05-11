import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandTemplate } from './template';

@Injectable()
export class ActionLogExecutor implements NodeExecutor {
  readonly type = 'action.log';
  readonly metadata: NodeMetadata = {
    type: 'action.log',
    category: 'action',
    label: 'Log-Zeile schreiben',
    description: 'Schreibt eine Nachricht in das Run-Log dieses Nodes.',
    allowedScopes: [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      message: z.string(),
      level: z.enum(['info', 'warn', 'error']).optional(),
    }),
    outputs: { message: 'string', level: 'string' },
    branches: ['success'],
  };
  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const message = expandTemplate(String(ctx.config.message ?? ''), ctx.runContext);
    const level = (ctx.config.level as string) ?? 'info';
    if (level === 'warn') ctx.logger.warn(message);
    else if (level === 'error') ctx.logger.error(message);
    else ctx.logger.info(message);
    return { status: 'success', output: { message, level } };
  }
}
