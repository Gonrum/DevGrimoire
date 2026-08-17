import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { TodosService } from '../../todos/todos.service';
import { TodoPriority, TodoStatus } from '../../todos/schemas/todo.schema';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandConfig } from './template';
import { asString, optionalEnum } from '../../common/tool-args';
import { asStringArray, errorMessage } from '../workflow-narrow';

@Injectable()
export class ActionTodoUpdateExecutor implements NodeExecutor {
  readonly type = 'action.todo-update';
  readonly metadata: NodeMetadata = {
    type: 'action.todo-update',
    category: 'action',
    label: 'Todo updaten',
    description: 'Aktualisiert Status, Priority, Tags oder Milestone-Bindung eines Todos.',
    allowedScopes: [WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      todoId: z.string().min(1),
      status: z.enum(['open', 'in_progress', 'review', 'done']).optional(),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      tags: z.array(z.string()).optional(),
      milestoneId: z.string().optional(),
    }),
    outputs: { todoId: 'string', updated: 'boolean' },
    branches: ['success', 'failure'],
  };

  constructor(private readonly todos: TodosService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const expanded = expandConfig(ctx.config, ctx.runContext);
    const todoId = (asString(expanded.todoId) ?? '').trim();
    if (!todoId) {
      return { status: 'failed', error: { code: 'invalid_config', message: 'todoId required' } };
    }
    // `UpdateTodoDto.status`/`.priority` sind echte TS-Enums; ein String aus der
    // Node-Konfiguration ist dorthin nicht zuweisbar, und genau das hatte das
    // frühere `as never` überdeckt. `optionalEnum` prüft gegen die Enum-Werte
    // und wirft bei einem ungültigen Wert — vorher lief er bis in die
    // Mongoose-Validierung und kam von dort als `todo_update_failed` zurück.
    let status: TodoStatus | undefined;
    let priority: TodoPriority | undefined;
    try {
      status = optionalEnum(expanded, 'status', Object.values(TodoStatus));
      priority = optionalEnum(expanded, 'priority', Object.values(TodoPriority));
    } catch (err: unknown) {
      return { status: 'failed', error: { code: 'invalid_config', message: errorMessage(err) } };
    }
    try {
      await this.todos.update(todoId, {
        status,
        priority,
        tags: asStringArray(expanded.tags),
        milestoneId: asString(expanded.milestoneId),
      });
      return { status: 'success', output: { todoId, updated: true } };
    } catch (err: unknown) {
      return { status: 'failed', error: { code: 'todo_update_failed', message: errorMessage(err) } };
    }
  }
}
