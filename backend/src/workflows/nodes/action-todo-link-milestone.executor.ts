import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { TodosService } from '../../todos/todos.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandConfig } from './template';

@Injectable()
export class ActionTodoLinkMilestoneExecutor implements NodeExecutor {
  readonly type = 'action.todo-link-milestone';
  readonly metadata: NodeMetadata = {
    type: 'action.todo-link-milestone',
    category: 'action',
    label: 'Todo an Milestone binden',
    description: 'Setzt milestoneId eines Todos.',
    allowedScopes: [WorkflowScope.PROJECT],
    configSchema: z.object({
      todoId: z.string().min(1),
      milestoneId: z.string().min(1),
    }),
    outputs: { todoId: 'string', milestoneId: 'string' },
    branches: ['success', 'failure'],
  };

  constructor(private readonly todos: TodosService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const expanded = expandConfig(ctx.config, ctx.runContext);
    const todoId = String(expanded.todoId ?? '').trim();
    const milestoneId = String(expanded.milestoneId ?? '').trim();
    if (!todoId || !milestoneId) {
      return { status: 'failed', error: { code: 'invalid_config', message: 'todoId and milestoneId required' } };
    }
    try {
      await this.todos.update(todoId, { milestoneId });
      return { status: 'success', output: { todoId, milestoneId } };
    } catch (err) {
      return { status: 'failed', error: { code: 'todo_link_failed', message: (err as Error).message } };
    }
  }
}
