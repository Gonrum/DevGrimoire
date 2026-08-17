import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Types } from 'mongoose';
import { KnowledgeService } from '../../knowledge/knowledge.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandConfig } from './template';
import { asString } from '../../common/tool-args';
import { asStringArray, errorMessage } from '../workflow-narrow';

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
      // Ohne das frühere `as never` greift die kontextuelle Typisierung des
      // DTO wieder: `scope` wird als `'project' | 'customer'` gelesen statt als
      // beliebiger String, der dorthin gar nicht zuweisbar war.
      const k = await this.knowledge.create({
        topic: String(expanded.topic),
        content: String(expanded.content),
        category: asString(expanded.category),
        tags: asStringArray(expanded.tags) ?? [],
        scope: projectId ? 'project' : 'customer',
        projectId,
        customerId,
      });
      return {
        status: 'success',
        output: { knowledgeId: k._id.toString() },
      };
    } catch (err: unknown) {
      return { status: 'failed', error: { code: 'knowledge_create_failed', message: errorMessage(err) } };
    }
  }
}
