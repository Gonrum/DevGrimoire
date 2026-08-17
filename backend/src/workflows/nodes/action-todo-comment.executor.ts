import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { TodosService } from '../../todos/todos.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandConfig } from './template';
import { asString } from '../../common/tool-args';
import { errorMessage } from '../workflow-narrow';

@Injectable()
export class ActionTodoCommentExecutor implements NodeExecutor {
  readonly type = 'action.todo-comment';
  readonly metadata: NodeMetadata = {
    type: 'action.todo-comment',
    category: 'action',
    label: 'Todo-Kommentar anhängen',
    description: 'Hängt einen Kommentar an ein bestehendes Todo. Author default "workflow".',
    allowedScopes: [WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      todoId: z.string().min(1),
      text: z.string().min(1),
      author: z.string().optional(),
    }),
    outputs: { todoId: 'string', commented: 'boolean' },
    branches: ['success', 'failure'],
  };

  constructor(private readonly todos: TodosService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const expanded = expandConfig(ctx.config, ctx.runContext);
    const todoId = (asString(expanded.todoId) ?? '').trim();
    const text = (asString(expanded.text) ?? '').trim();
    if (!todoId || !text) {
      return { status: 'failed', error: { code: 'invalid_config', message: 'todoId and text required' } };
    }
    const author = asString(expanded.author) ?? 'workflow';
    try {
      await this.todos.addComment(todoId, text, author);
      return { status: 'success', output: { todoId, commented: true } };
    } catch (err: unknown) {
      return { status: 'failed', error: { code: 'todo_comment_failed', message: errorMessage(err) } };
    }
  }
}
