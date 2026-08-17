import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Types } from 'mongoose';
import { ChangelogService } from '../../changelog/changelog.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandConfig } from './template';
import { asString } from '../../common/tool-args';
import { asStringArray, errorMessage } from '../workflow-narrow';

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
        version: asString(expanded.version),
        summary: asString(expanded.summary),
        changes: asStringArray(expanded.changes) ?? [],
        component: asString(expanded.component),
      });
      return {
        status: 'success',
        output: {
          changelogId: cl._id.toString(),
          version: cl.version ?? null,
        },
      };
    } catch (err: unknown) {
      return { status: 'failed', error: { code: 'changelog_create_failed', message: errorMessage(err) } };
    }
  }
}
