import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Types } from 'mongoose';
import { ChangelogService } from '../../changelog/changelog.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandConfig } from './template';

@Injectable()
export class ActionChangelogAddExecutor implements NodeExecutor {
  readonly type = 'action.changelog-add';
  readonly metadata: NodeMetadata = {
    type: 'action.changelog-add',
    category: 'action',
    label: 'Changelog-Eintrag anlegen',
    description: 'Fügt einen Changelog-Eintrag im Projekt-Scope hinzu.',
    allowedScopes: [WorkflowScope.PROJECT],
    configSchema: z.object({
      version: z.string().optional(),
      summary: z.string().optional(),
      changes: z.array(z.string()).min(1),
      component: z.string().optional(),
    }),
    outputs: { changelogId: 'string', version: 'string|null' },
    branches: ['success', 'failure'],
  };

  constructor(private readonly changelog: ChangelogService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const expanded = expandConfig(ctx.config, ctx.runContext);
    const projectId =
      ctx.run.projectId instanceof Types.ObjectId ? ctx.run.projectId.toString() : undefined;
    if (!projectId) {
      return { status: 'failed', error: { code: 'invalid_scope', message: 'changelog-add requires project scope' } };
    }
    try {
      const cl = await this.changelog.create({
        projectId,
        version: expanded.version as string | undefined,
        summary: expanded.summary as string | undefined,
        changes: (expanded.changes as string[]) ?? [],
        component: expanded.component as string | undefined,
      } as never);
      return {
        status: 'success',
        output: {
          changelogId: String((cl as { _id: unknown })._id),
          version: (cl as { version?: string }).version ?? null,
        },
      };
    } catch (err) {
      return { status: 'failed', error: { code: 'changelog_create_failed', message: (err as Error).message } };
    }
  }
}
