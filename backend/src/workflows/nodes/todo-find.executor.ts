import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { TodosService } from '../../todos/todos.service';
import { TodoDocument, TodoPriority, TodoStatus } from '../../todos/schemas/todo.schema';
import { WorkflowScopeGuard } from '../workflow-scope.guard';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { errorMessage } from '../workflow-narrow';
import { expandConfig } from './template';

const configSchema = z.object({
  statuses: z.array(z.nativeEnum(TodoStatus)).min(1).default([TodoStatus.OPEN]),
  tags: z.array(z.string().min(1)).optional(),
  milestoneId: z.string().min(1).optional(),
  priority: z.nativeEnum(TodoPriority).optional(),
  sort: z.enum(['oldest', 'newest', 'priority']).default('oldest'),
  limit: z.number().int().min(1).max(20).default(1),
});

function toOutput(todo: TodoDocument): Record<string, unknown> {
  return {
    id: todo._id.toString(),
    number: todo.number,
    title: todo.title,
    description: todo.description,
    status: todo.status,
    priority: todo.priority,
    tags: todo.tags,
    createdAt: todo.createdAt,
  };
}

/**
 * Findet Todos im Scope des Laufs, z. B. den ältesten offenen eines Projekts.
 * Kein Treffer ist kein Fehler, sondern der Zweig `custom` — so kann ein
 * Workflow "nichts zu tun" gezielt verzweigen.
 */
@Injectable()
export class TodoFindExecutor implements NodeExecutor {
  readonly type = 'todo.find';
  readonly metadata: NodeMetadata = {
    type: 'todo.find',
    // `control`, damit der Editor-Test den Node wirklich ausführt (reine Lesung).
    category: 'control',
    label: 'Todo suchen',
    description:
      'Sucht Todos im Projekt/Kunden-Scope des Laufs (Status, Tags, Milestone, Priorität). ' +
      'Zweig "success" bei Treffern, "custom" wenn nichts gefunden wurde.',
    allowedScopes: [WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema,
    outputs: { todo: 'object|null', todos: 'array', count: 'number' },
    branches: ['success', 'custom'],
  };

  constructor(
    private readonly todos: TodosService,
    private readonly scope: WorkflowScopeGuard,
  ) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const parsed = configSchema.safeParse(expandConfig(ctx.config, ctx.runContext));
    if (!parsed.success) {
      return {
        status: 'failed',
        error: { code: 'invalid_config', message: parsed.error.issues.map((i) => i.message).join('; ') },
      };
    }
    const cfg = parsed.data;
    try {
      const owners = await this.scope.allowedOwners(ctx.run);
      // Projekt-Lauf: nur das eigene Projekt. `allowedOwners` liefert zusätzlich
      // die verlinkten Kunden — deren Todos gehören aber nicht zum Projekt, ein
      // „ältester offener Todo" griffe sonst in fremde Kundenarbeit. Kunden-Lauf:
      // eigener Kunde plus verlinkte Projekte, wie `allowedOwners` sie liefert.
      const customerIds = ctx.run.projectId ? [] : owners.customerIds;
      const found = await this.todos.findForWorkflow({
        projectIds: owners.projectIds,
        customerIds,
        statuses: cfg.statuses,
        tags: cfg.tags,
        milestoneId: cfg.milestoneId,
        priority: cfg.priority,
        sort: cfg.sort,
        limit: cfg.limit,
      });
      const list = found.map(toOutput);
      return {
        status: 'success',
        branch: list.length > 0 ? 'success' : 'custom',
        output: { todo: list[0] ?? null, todos: list, count: list.length },
      };
    } catch (err: unknown) {
      return { status: 'failed', error: { code: 'todo_find_failed', message: errorMessage(err) } };
    }
  }
}
