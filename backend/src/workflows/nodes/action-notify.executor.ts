import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NotificationsService } from '../../notifications/notifications.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandTemplate } from './template';

@Injectable()
export class ActionNotifyExecutor implements NodeExecutor {
  readonly type = 'action.notify';
  constructor(private readonly notificationsService: NotificationsService) {}

  readonly metadata: NodeMetadata = {
    type: 'action.notify',
    category: 'action',
    label: 'Notification senden',
    description: 'Erzeugt eine Notification (Web-Push, wenn aktiviert).',
    allowedScopes: [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      title: z.string().min(1),
      body: z.string().optional(),
      url: z.string().optional(),
      category: z.string().optional(),
    }),
    outputs: { notificationId: 'string' },
    branches: ['success', 'failure'],
  };

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
