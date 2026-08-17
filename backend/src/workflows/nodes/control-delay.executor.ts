import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { asString } from '../../common/tool-args';
import { asNumber } from '../workflow-narrow';

const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

@Injectable()
export class ControlDelayExecutor implements NodeExecutor {
  readonly type = 'control.delay';
  readonly metadata: NodeMetadata = {
    type: 'control.delay',
    category: 'control',
    label: 'Wartezeit (Delay)',
    description:
      'Pausiert den Run für delayMs Millisekunden oder bis zu einem ISO-Zeitpunkt. Crash-fest via WorkflowDelayScheduler.',
    allowedScopes: [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z
      .object({
        delayMs: z.number().int().positive().max(MAX_DELAY_MS).optional(),
        until: z.string().datetime().optional(),
      })
      .refine((d) => (d.delayMs && !d.until) || (!d.delayMs && d.until), {
        message: 'control.delay needs exactly one of delayMs or until',
      }),
    outputs: { resumedAt: 'string', waitedMs: 'number' },
    branches: ['success'],
  };

  // Kein `async`: der Node berechnet nur einen Zeitpunkt.
  execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const delayMs = asNumber(ctx.config.delayMs);
    const resumeAt = delayMs
      ? new Date(Date.now() + delayMs)
      : new Date(asString(ctx.config.until) ?? '');

    if (Number.isNaN(resumeAt.getTime())) {
      return Promise.resolve({
        status: 'failed',
        error: { code: 'invalid_config', message: 'invalid resumeAt' },
      });
    }

    if (resumeAt.getTime() <= Date.now()) {
      // Already in the past — succeed immediately with zero wait.
      return Promise.resolve({
        status: 'success',
        output: { resumedAt: new Date().toISOString(), waitedMs: 0 },
      });
    }

    return Promise.resolve({
      status: 'waiting',
      waitingFor: { type: 'delay', resumeAt },
    });
  }
}
