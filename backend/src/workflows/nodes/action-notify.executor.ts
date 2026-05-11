import { Injectable } from '@nestjs/common';
import { NotificationsService } from '../../notifications/notifications.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { expandTemplate } from './template';

@Injectable()
export class ActionNotifyExecutor implements NodeExecutor {
  readonly type = 'action.notify';
  constructor(private readonly notificationsService: NotificationsService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const title = expandTemplate(String(ctx.config.title ?? ''), ctx.runContext);
    const body = expandTemplate(String(ctx.config.body ?? ''), ctx.runContext);
    if (!title) {
      return {
        status: 'failed',
        error: { code: 'invalid_config', message: 'notify requires a title' },
      };
    }
    const url = ctx.config.url as string | undefined;
    const category = (ctx.config.category as string | undefined) ?? 'workflow';
    const n = await this.notificationsService.create(title, body, url, category);
    return { status: 'success', output: { notificationId: String(n._id) } };
  }
}
