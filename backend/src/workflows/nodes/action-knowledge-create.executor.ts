import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Types } from 'mongoose';
import { KnowledgeService } from '../../knowledge/knowledge.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandConfig } from './template';

@Injectable()
export class ActionKnowledgeCreateExecutor implements NodeExecutor {
  readonly type = 'action.knowledge-create';
  readonly metadata: NodeMetadata = {
    type: 'action.knowledge-create',
    category: 'action',
    label: 'Knowledge-Eintrag erstellen',
    description: 'Speichert einen Knowledge-Eintrag im Run-Scope (project|customer).',
    allowedScopes: [WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      topic: z.string().min(1),
      content: z.string().min(1),
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    outputs: { knowledgeId: 'string' },
    branches: ['success', 'failure'],
  };

  constructor(private readonly knowledge: KnowledgeService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const expanded = expandConfig(ctx.config, ctx.runContext);
    const projectId =
      ctx.run.projectId instanceof Types.ObjectId ? ctx.run.projectId.toString() : undefined;
    const customerId =
      ctx.run.customerId instanceof Types.ObjectId ? ctx.run.customerId.toString() : undefined;
    try {
      const k = await this.knowledge.create({
        topic: String(expanded.topic),
        content: String(expanded.content),
        category: expanded.category as string | undefined,
        tags: (expanded.tags as string[]) ?? [],
        scope: projectId ? 'project' : 'customer',
        projectId,
        customerId,
      } as never);
      return {
        status: 'success',
        output: { knowledgeId: String((k as { _id: unknown })._id) },
      };
    } catch (err) {
      return { status: 'failed', error: { code: 'knowledge_create_failed', message: (err as Error).message } };
    }
  }
}
