import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { TodosService } from '../../todos/todos.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandConfig } from './template';

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
    const todoId = String(expanded.todoId ?? '').trim();
    if (!todoId) {
      return { status: 'failed', error: { code: 'invalid_config', message: 'todoId required' } };
    }
    try {
      await this.todos.update(todoId, {
        status: expanded.status as never,
        priority: expanded.priority as never,
        tags: expanded.tags as string[] | undefined,
        milestoneId: expanded.milestoneId as string | undefined,
      });
      return { status: 'success', output: { todoId, updated: true } };
    } catch (err) {
      return { status: 'failed', error: { code: 'todo_update_failed', message: (err as Error).message } };
    }
  }
}
