import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { TodosService } from '../../todos/todos.service';
import { TodoPriority } from '../../todos/schemas/todo.schema';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { expandConfig } from './template';

@Injectable()
export class ActionTodoCreateExecutor implements NodeExecutor {
  readonly type = 'action.todo-create';
  constructor(private readonly todosService: TodosService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const expanded = expandConfig(ctx.config, ctx.runContext);
    const projectId =
      (expanded.projectId as string | undefined) ??
      (ctx.run.projectId instanceof Types.ObjectId ? ctx.run.projectId.toString() : undefined);
    const customerId =
      (expanded.customerId as string | undefined) ??
      (ctx.run.customerId instanceof Types.ObjectId ? ctx.run.customerId.toString() : undefined);

    const title = String(expanded.title ?? '').trim();
    if (!title) {
      return {
        status: 'failed',
        error: { code: 'invalid_config', message: 'todo-create requires a title' },
      };
    }

    const rawPriority = expanded.priority as string | undefined;
    const priority = Object.values(TodoPriority).includes(rawPriority as TodoPriority)
      ? (rawPriority as TodoPriority)
      : undefined;

    const todo = await this.todosService.create({
      title,
      description: expanded.description as string | undefined,
      priority,
      tags: (expanded.tags as string[]) ?? [],
      milestoneId: expanded.milestoneId as string | undefined,
      projectId,
      customerId,
    });

    return {
      status: 'success',
      output: { todoId: todo._id.toString(), todoNumber: todo.displayNumber ?? null },
    };
  }
}
