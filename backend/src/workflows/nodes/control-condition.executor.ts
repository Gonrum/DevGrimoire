import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { lookupPath } from './template';
import { evalOp, ConditionOp } from './condition-ops';

const opSchema = z.enum(['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'exists', 'truthy']);
const branchSchema = z.enum(['success', 'failure', 'custom']);

@Injectable()
export class ControlConditionExecutor implements NodeExecutor {
  readonly type = 'control.condition';
  readonly metadata: NodeMetadata = {
    type: 'control.condition',
    category: 'control',
    label: 'Condition / Switch',
    description: 'Wertet Cases gegen den Run-Context aus und wählt die ausgehende Branch.',
    allowedScopes: [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      cases: z.array(
        z.object({
          when: z.object({
            path: z.string().min(1),
            op: opSchema,
            value: z.unknown().optional(),
          }),
          branch: branchSchema,
        }),
      ),
      default: branchSchema.optional(),
    }),
    outputs: { matchedCase: 'number|null', matchedPath: 'string|null', lhs: 'unknown' },
    branches: ['success', 'failure', 'custom'],
  };

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const cases = (ctx.config.cases as Array<{
      when: { path: string; op: ConditionOp; value?: unknown };
      branch: 'success' | 'failure' | 'custom';
    }>) ?? [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const lhs = lookupPath(c.when.path, ctx.runContext);
      if (evalOp(lhs, c.when.op, c.when.value)) {
        return {
          status: 'success',
          output: { matchedCase: i, matchedPath: c.when.path, lhs },
          branch: c.branch,
        };
      }
    }
    const def = (ctx.config.default as 'success' | 'failure' | 'custom' | undefined) ?? 'failure';
    return {
      status: 'success',
      output: { matchedCase: null, matchedPath: null, lhs: null },
      branch: def,
    };
  }
}
