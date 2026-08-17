import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';

@Injectable()
export class TriggerManualExecutor implements NodeExecutor {
  readonly type = 'trigger.manual';
  readonly metadata: NodeMetadata = {
    type: 'trigger.manual',
    category: 'trigger',
    label: 'Manueller Trigger',
    description: 'Workflow startet, wenn ein User oder Agent ihn manuell auslöst.',
    allowedScopes: [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({}).strict(),
    outputs: {},
    branches: ['success'],
  };
  // Ohne Parameter: der Node braucht den Context nicht, und ein ungenutztes
  // `_ctx` ist trotz Unterstrich ein `no-unused-vars`-Fund (die Regel ist hier
  // ohne `argsIgnorePattern` konfiguriert). Eine Methode mit weniger Parametern
  // erfüllt `NodeExecutor.execute` weiterhin.
  execute(): Promise<NodeResult> {
    return Promise.resolve({ status: 'success', output: {} });
  }
}
