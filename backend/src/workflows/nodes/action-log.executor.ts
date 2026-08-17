import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandTemplate } from './template';
import { asString } from '../../common/tool-args';

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
  // Kein `async`: der Node arbeitet rein synchron. `Promise.resolve` erfüllt
  // die `NodeExecutor`-Signatur, ohne eine Await-Stelle zu erfinden.
  execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const message = expandTemplate(asString(ctx.config.message) ?? '', ctx.runContext);
    const level = asString(ctx.config.level) ?? 'info';
    if (level === 'warn') ctx.logger.warn(message);
    else if (level === 'error') ctx.logger.error(message);
    else ctx.logger.info(message);
    return Promise.resolve({ status: 'success', output: { message, level } });
  }
}
