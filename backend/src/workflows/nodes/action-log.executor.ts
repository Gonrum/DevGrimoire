import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { expandTemplate } from './template';

@Injectable()
export class ActionLogExecutor implements NodeExecutor {
  readonly type = 'action.log';
  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const message = expandTemplate(String(ctx.config.message ?? ''), ctx.runContext);
    const level = (ctx.config.level as string) ?? 'info';
    if (level === 'warn') ctx.logger.warn(message);
    else if (level === 'error') ctx.logger.error(message);
    else ctx.logger.info(message);
    return { status: 'success', output: { message, level } };
  }
}
