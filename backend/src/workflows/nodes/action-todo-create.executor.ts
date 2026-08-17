import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Types } from 'mongoose';
import { TodosService } from '../../todos/todos.service';
import { TodoPriority } from '../../todos/schemas/todo.schema';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandConfig } from './template';
import { asString, optionalEnum } from '../../common/tool-args';
import { asStringArray, errorMessage } from '../workflow-narrow';

@Injectable()
export class ActionTodoCreateExecutor implements NodeExecutor {
  readonly type = 'action.todo-create';
  constructor(private readonly todosService: TodosService) {}

  readonly metadata: NodeMetadata = {
    type: 'action.todo-create',
    category: 'action',
    label: 'Todo anlegen',
    description: 'Erzeugt ein neues Todo im Run-Scope. ProjectId/CustomerId werden aus dem Run inferiert.',
    allowedScopes: [WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      tags: z.array(z.string()).optional(),
      milestoneId: z.string().optional(),
      projectId: z.string().optional(),
      customerId: z.string().optional(),
    }),
    outputs: { todoId: 'string', todoNumber: 'string|null' },
    branches: ['success', 'failure'],
  };

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const expanded = expandConfig(ctx.config, ctx.runContext);
    const projectId =
      asString(expanded.projectId) ??
      (ctx.run.projectId instanceof Types.ObjectId ? ctx.run.projectId.toString() : undefined);
    const customerId =
      asString(expanded.customerId) ??
      (ctx.run.customerId instanceof Types.ObjectId ? ctx.run.customerId.toString() : undefined);

    const title = (asString(expanded.title) ?? '').trim();
    if (!title) {
      return {
        status: 'failed',
        error: { code: 'invalid_config', message: 'todo-create requires a title' },
      };
    }

    // `optionalEnum` prüft gegen die Enum-Werte und liefert damit `TodoPriority`
    // aus einer echten Laufzeitprüfung. Anders als vorher wird ein *ungültiger*
    // Wert jetzt abgelehnt statt still auf `undefined` zu fallen — ein
    // Tippfehler in der Node-Konfiguration bleibt damit nicht unsichtbar.
    let priority: TodoPriority | undefined;
    try {
      priority = optionalEnum(expanded, 'priority', Object.values(TodoPriority));
    } catch (err: unknown) {
      return { status: 'failed', error: { code: 'invalid_config', message: errorMessage(err) } };
    }

    const todo = await this.todosService.create({
      title,
      description: asString(expanded.description),
      priority,
      tags: asStringArray(expanded.tags) ?? [],
      milestoneId: asString(expanded.milestoneId),
      projectId,
      customerId,
    });

    return {
      status: 'success',
      output: { todoId: todo._id.toString(), todoNumber: todo.displayNumber ?? null },
    };
  }
}
