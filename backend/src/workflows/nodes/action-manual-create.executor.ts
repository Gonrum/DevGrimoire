import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Types } from 'mongoose';
import { ManualsService } from '../../manuals/manuals.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandConfig } from './template';
import { asString } from '../../common/tool-args';
import { asNumber, errorMessage } from '../workflow-narrow';

@Injectable()
export class ActionManualCreateExecutor implements NodeExecutor {
  readonly type = 'action.manual-create';
  readonly metadata: NodeMetadata = {
    type: 'action.manual-create',
    category: 'action',
    label: 'Manual-Seite anlegen',
    description: 'Erzeugt eine Manual-Seite im Run-Scope (project|customer, exklusiv).',
    allowedScopes: [WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      title: z.string().min(1),
      content: z.string().optional(),
      category: z.string().optional(),
      sortOrder: z.number().optional(),
    }),
    outputs: { manualId: 'string' },
    branches: ['success', 'failure'],
  };

  constructor(private readonly manuals: ManualsService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const expanded = expandConfig(ctx.config, ctx.runContext);
    const projectId =
      ctx.run.projectId instanceof Types.ObjectId ? ctx.run.projectId.toString() : undefined;
    const customerId =
      ctx.run.customerId instanceof Types.ObjectId ? ctx.run.customerId.toString() : undefined;
    try {
      const m = await this.manuals.create({
        title: String(expanded.title),
        content: asString(expanded.content),
        category: asString(expanded.category),
        sortOrder: asNumber(expanded.sortOrder),
        projectId,
        customerId,
      });
      return {
        status: 'success',
        output: { manualId: m._id.toString() },
      };
    } catch (err: unknown) {
      return { status: 'failed', error: { code: 'manual_create_failed', message: errorMessage(err) } };
    }
  }
}
