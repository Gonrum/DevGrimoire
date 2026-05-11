# DevGrimoire-Native Workflow Nodes Implementation Plan (T-252)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the production node catalog to the workflow engine — 11 new executors (CRUD, control-flow, event-trigger, agent-task), a NodeMetadata + JSON-Schema endpoint, a dedicated workflow-agent LLM service, and a persistent delay scheduler.

**Architecture:** Each Node-Executor exposes `metadata` (label, category, zod configSchema, outputs, branches). A new `GET /api/workflows/node-types` endpoint exports the catalog as JSON-Schemas via `zod-to-json-schema`. Control-flow extends `waitingFor` union with `{type:'delay', resumeAt}` and adds `WAITING_FOR_TIMER` run-status; a new `@Cron('*/15 * * * * *')` `WorkflowDelayScheduler` resumes delayed node-runs. Event triggers come from a `@OnEvent(PROJECT_CHANGED)` listener that fan-outs runs. Agent-task is a separate `WorkflowAgentService` with its own encrypted settings endpoint, doing non-streaming LLM calls via OpenAI- or Anthropic-protocol and dispatching MCP tools through the existing `ChatToolsService.execute` with a per-node allowlist.

**Tech Stack:** NestJS, Mongoose, `@nestjs/event-emitter`, `@nestjs/schedule`, zod (existing transitive), `zod-to-json-schema` (new dep), TypeScript. Verification via `.cjs` check scripts following the T-250 pattern.

**Reference spec:** [`docs/workflow-nodes.md`](workflow-nodes.md). Foundation engine: [`docs/workflow-runner.md`](workflow-runner.md).

---

## File Map

**New files:**
- `backend/src/workflows/engine/node-metadata.ts` — `NodeMetadata` interface + `toJsonSchemaCatalog()` helper
- `backend/src/workflows/engine/workflow-event-listener.service.ts`
- `backend/src/workflows/engine/workflow-delay-scheduler.ts`
- `backend/src/workflows/workflow-node-types.controller.ts` — `GET /api/workflows/node-types`
- `backend/src/workflows/workflow-agent.service.ts` — encrypted endpoint storage + LLM/tool loop
- `backend/src/workflows/workflow-agent.controller.ts` — `GET/PUT /api/workflows/agent-config`
- `backend/src/workflows/dto/workflow-agent.dto.ts`
- `backend/src/workflows/nodes/condition-ops.ts`
- `backend/src/workflows/nodes/trigger-project-event.executor.ts`
- `backend/src/workflows/nodes/trigger-customer-event.executor.ts`
- `backend/src/workflows/nodes/action-todo-update.executor.ts`
- `backend/src/workflows/nodes/action-todo-comment.executor.ts`
- `backend/src/workflows/nodes/action-todo-link-milestone.executor.ts`
- `backend/src/workflows/nodes/action-knowledge-create.executor.ts`
- `backend/src/workflows/nodes/action-manual-create.executor.ts`
- `backend/src/workflows/nodes/action-changelog-add.executor.ts`
- `backend/src/workflows/nodes/action-user-question.executor.ts`
- `backend/src/workflows/nodes/control-condition.executor.ts`
- `backend/src/workflows/nodes/control-delay.executor.ts`
- `backend/src/workflows/nodes/agent-task.executor.ts`
- `backend/scripts/workflow-nodes-units-check.cjs`
- `backend/scripts/workflow-nodes-engine-check.cjs`

**Modified files:**
- `backend/package.json` — add `zod-to-json-schema` dep, two `npm run check:*` scripts
- `backend/src/workflows/engine/types.ts` — extend `NodeExecutor` with `readonly metadata: NodeMetadata`
- `backend/src/workflows/engine/node-registry.ts` — `getMetadata(type)`, `listMetadata()`
- `backend/src/workflows/schemas/workflow-run.schema.ts` — add `WAITING_FOR_TIMER` to `WorkflowRunStatus`
- `backend/src/workflows/schemas/workflow-node-run.schema.ts` — extend `waitingFor` union, add index
- `backend/src/workflows/engine/workflow-engine.service.ts` — branchMap in `handleQuestionAnswered`, `resumeDelayedNode`, delay-waiting status path
- `backend/src/workflows/workflows.service.ts` — `startRun` writes `dto.input` into `run.context.input`; activation-gate runs zod schema validation
- `backend/src/workflows/workflows.module.ts` — register all new executors + services
- `backend/src/workflows/nodes/trigger-manual.executor.ts`, `trigger-schedule.executor.ts`, `action-log.executor.ts`, `action-todo-create.executor.ts`, `action-notify.executor.ts` — add `metadata` field
- `backend/src/workflows/nodes/template.ts` — export `lookup` as public `lookupPath`
- `backend/src/mcp-tools.ts`, `backend/src/mcp-server.ts`, `backend/src/main.ts` — `workflow_node_types_list` MCP tool

---

## Task 1: Add `zod-to-json-schema` dependency

**Files:** `backend/package.json`

- [ ] **Step 1: Install**

```bash
cd backend && npm install zod-to-json-schema@^3
```

Expected: `package.json` gains `"zod-to-json-schema": "^3.x.x"` in `dependencies`.

- [ ] **Step 2: Smoke-test**

```bash
cd backend && node -e "const { zodToJsonSchema } = require('zod-to-json-schema'); const { z } = require('zod'); console.log(JSON.stringify(zodToJsonSchema(z.object({ name: z.string() }))));"
```

Expected: Valid JSON-Schema printed.

- [ ] **Step 3: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "chore(workflows): add zod-to-json-schema dep for node-metadata (T-252)"
```

---

## Task 2: Schema extensions (run-status, waitingFor union, index)

**Files:**
- Modify: `backend/src/workflows/schemas/workflow-run.schema.ts`
- Modify: `backend/src/workflows/schemas/workflow-node-run.schema.ts`

- [ ] **Step 1: Add `WAITING_FOR_TIMER` to `WorkflowRunStatus`**

Open `workflow-run.schema.ts`. In the `WorkflowRunStatus` enum, after `WAITING_FOR_USER = 'waiting_for_user'`, add:

```ts
  WAITING_FOR_TIMER = 'waiting_for_timer',
```

- [ ] **Step 2: Extend `waitingFor` typing in NodeRun schema**

Open `workflow-node-run.schema.ts`. The existing `waitingFor` Prop currently types as `{ type: 'question'; refId: Types.ObjectId }`. Replace its type annotation with the union, but keep `@Prop({ type: Object })` as-is (Mongoose stores it as a free-form sub-document). Specifically, change:

```ts
  @Prop({ type: Object })
  waitingFor?: { type: 'question'; refId: Types.ObjectId };
```

to:

```ts
  @Prop({ type: Object })
  waitingFor?:
    | { type: 'question'; refId: Types.ObjectId }
    | { type: 'delay'; resumeAt: Date };
```

- [ ] **Step 3: Add index for the delay scheduler pick**

At the bottom of `workflow-node-run.schema.ts`, after the existing indexes, add:

```ts
WorkflowNodeRunSchema.index({ 'waitingFor.type': 1, 'waitingFor.resumeAt': 1, status: 1 });
```

- [ ] **Step 4: Build**

```bash
cd backend && npm run build
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/workflows/schemas/workflow-run.schema.ts backend/src/workflows/schemas/workflow-node-run.schema.ts
git commit -m "feat(workflows): WAITING_FOR_TIMER status + delay waitingFor union (T-252)"
```

---

## Task 3: NodeMetadata interface + JSON-Schema export

**Files:**
- Create: `backend/src/workflows/engine/node-metadata.ts`
- Modify: `backend/src/workflows/engine/types.ts`
- Modify: `backend/src/workflows/engine/node-registry.ts`

- [ ] **Step 1: Write `node-metadata.ts`**

```ts
import { ZodSchema } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { WorkflowScope } from '../schemas/workflow-definition.schema';

export type NodeBranch = 'success' | 'failure' | 'custom';

export interface NodeMetadata {
  type: string;
  category: 'trigger' | 'action' | 'control' | 'agent';
  label: string;
  description: string;
  allowedScopes: WorkflowScope[];
  configSchema: ZodSchema;
  outputs: Record<string, string>;
  branches?: NodeBranch[];
}

export interface NodeMetadataPublic {
  type: string;
  category: NodeMetadata['category'];
  label: string;
  description: string;
  allowedScopes: WorkflowScope[];
  configJsonSchema: unknown;
  outputs: Record<string, string>;
  branches: NodeBranch[];
}

export function toPublicMetadata(meta: NodeMetadata): NodeMetadataPublic {
  return {
    type: meta.type,
    category: meta.category,
    label: meta.label,
    description: meta.description,
    allowedScopes: meta.allowedScopes,
    configJsonSchema: zodToJsonSchema(meta.configSchema, { name: meta.type }),
    outputs: meta.outputs,
    branches: meta.branches ?? ['success', 'failure'],
  };
}
```

- [ ] **Step 2: Extend `NodeExecutor` in `types.ts`**

In `backend/src/workflows/engine/types.ts`, change:

```ts
export interface NodeExecutor {
  readonly type: string;
  execute(ctx: NodeExecutionContext): Promise<NodeResult>;
}
```

to:

```ts
import { NodeMetadata } from './node-metadata';

export interface NodeExecutor {
  readonly type: string;
  readonly metadata: NodeMetadata;
  execute(ctx: NodeExecutionContext): Promise<NodeResult>;
}
```

(Place the new `import` near the bottom of the existing imports.)

- [ ] **Step 3: Extend `NodeRegistry` with metadata accessors**

In `backend/src/workflows/engine/node-registry.ts`, after the existing `list()` method add:

```ts
  getMetadata(type: string) {
    return this.get(type).metadata;
  }

  listMetadata() {
    return [...this.executors.values()].map((e) => e.metadata);
  }
```

- [ ] **Step 4: Build**

The build WILL fail until Tasks 4-5 retrofit the existing executors with `metadata`. Skip the build check here and proceed to Task 4. Do NOT commit yet.

---

## Task 4: Retrofit T-250 executors with NodeMetadata

**Files:**
- Modify: `backend/src/workflows/nodes/trigger-manual.executor.ts`
- Modify: `backend/src/workflows/nodes/trigger-schedule.executor.ts`
- Modify: `backend/src/workflows/nodes/action-log.executor.ts`
- Modify: `backend/src/workflows/nodes/action-todo-create.executor.ts`
- Modify: `backend/src/workflows/nodes/action-notify.executor.ts`

Each existing T-250 executor currently has `readonly type = '...'` and `execute(...)`. Add a `readonly metadata: NodeMetadata` field above `execute`. Below is the metadata block for each — paste into the corresponding file.

- [ ] **Step 1: `trigger-manual.executor.ts`**

Add imports:
```ts
import { z } from 'zod';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
```

Add inside class, above `execute`:
```ts
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
```

- [ ] **Step 2: `trigger-schedule.executor.ts`**

Add the same imports as Step 1. Add:
```ts
  readonly metadata: NodeMetadata = {
    type: 'trigger.schedule',
    category: 'trigger',
    label: 'Schedule-Trigger',
    description: 'Workflow startet zu festgelegten Zeiten (Cron/Intervall). Konfiguration des Schedule liegt auf dem Workflow-Trigger, nicht am Node.',
    allowedScopes: [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({}).strict(),
    outputs: { scheduleSlotAt: 'string|null' },
    branches: ['success'],
  };
```

- [ ] **Step 3: `action-log.executor.ts`**

Add the same imports plus `z.enum`. Add:
```ts
  readonly metadata: NodeMetadata = {
    type: 'action.log',
    category: 'action',
    label: 'Log-Zeile schreiben',
    description: 'Schreibt eine Nachricht in das Run-Log dieses Nodes.',
    allowedScopes: [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      message: z.string(),
      level: z.enum(['info', 'warn', 'error']).optional(),
    }),
    outputs: { message: 'string', level: 'string' },
    branches: ['success'],
  };
```

- [ ] **Step 4: `action-todo-create.executor.ts`**

Add imports. Add:
```ts
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
```

- [ ] **Step 5: `action-notify.executor.ts`**

Add imports. Add:
```ts
  readonly metadata: NodeMetadata = {
    type: 'action.notify',
    category: 'action',
    label: 'Notification senden',
    description: 'Erzeugt eine Notification (Web-Push, wenn aktiviert).',
    allowedScopes: [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      title: z.string().min(1),
      body: z.string().optional(),
      url: z.string().optional(),
      category: z.string().optional(),
    }),
    outputs: { notificationId: 'string' },
    branches: ['success', 'failure'],
  };
```

- [ ] **Step 6: Build**

```bash
cd backend && npm run build
```

Expected: clean (this build covers Task 3 + 4 together).

- [ ] **Step 7: Commit (Task 3 + 4)**

```bash
git add backend/src/workflows/engine/node-metadata.ts \
  backend/src/workflows/engine/types.ts \
  backend/src/workflows/engine/node-registry.ts \
  backend/src/workflows/nodes/trigger-manual.executor.ts \
  backend/src/workflows/nodes/trigger-schedule.executor.ts \
  backend/src/workflows/nodes/action-log.executor.ts \
  backend/src/workflows/nodes/action-todo-create.executor.ts \
  backend/src/workflows/nodes/action-notify.executor.ts
git commit -m "feat(workflows): NodeMetadata interface + retrofit T-250 executors (T-252)"
```

---

## Task 5: Export `lookupPath` from template helper

**Files:** Modify `backend/src/workflows/nodes/template.ts`

The existing `lookup` function is module-private. Both `condition-ops` and `control.condition` need it. Export it under the more descriptive name `lookupPath` while keeping internal callers working.

- [ ] **Step 1: Refactor**

Open `backend/src/workflows/nodes/template.ts`. Change the `function lookup(path: string, root: Record<string, unknown>): unknown {...}` declaration to:

```ts
export function lookupPath(path: string, root: Record<string, unknown>): unknown {
```

Then inside the same file change every internal call site of `lookup(...)` to `lookupPath(...)` (only call site is inside `expandTemplate`).

- [ ] **Step 2: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/workflows/nodes/template.ts
git commit -m "refactor(workflows): export lookup as lookupPath for downstream nodes (T-252)"
```

---

## Task 6: Mini-action executors (6 files, one commit)

**Files (all new):**
- `backend/src/workflows/nodes/action-todo-update.executor.ts`
- `backend/src/workflows/nodes/action-todo-comment.executor.ts`
- `backend/src/workflows/nodes/action-todo-link-milestone.executor.ts`
- `backend/src/workflows/nodes/action-knowledge-create.executor.ts`
- `backend/src/workflows/nodes/action-manual-create.executor.ts`
- `backend/src/workflows/nodes/action-changelog-add.executor.ts`

All use `expandConfig(ctx.config, ctx.runContext)` for template expansion.

- [ ] **Step 1: `action-todo-update.executor.ts`**

```ts
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
      return {
        status: 'failed',
        error: { code: 'todo_update_failed', message: (err as Error).message },
      };
    }
  }
}
```

- [ ] **Step 2: `action-todo-comment.executor.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { TodosService } from '../../todos/todos.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandConfig } from './template';

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
    const todoId = String(expanded.todoId ?? '').trim();
    const text = String(expanded.text ?? '').trim();
    if (!todoId || !text) {
      return { status: 'failed', error: { code: 'invalid_config', message: 'todoId and text required' } };
    }
    const author = (expanded.author as string | undefined) ?? 'workflow';
    try {
      await this.todos.addComment(todoId, text, author);
      return { status: 'success', output: { todoId, commented: true } };
    } catch (err) {
      return {
        status: 'failed',
        error: { code: 'todo_comment_failed', message: (err as Error).message },
      };
    }
  }
}
```

- [ ] **Step 3: `action-todo-link-milestone.executor.ts`**

```ts
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
      return {
        status: 'failed',
        error: { code: 'todo_link_failed', message: (err as Error).message },
      };
    }
  }
}
```

- [ ] **Step 4: `action-knowledge-create.executor.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Types } from 'mongoose';
import { KnowledgeService } from '../../knowledge/knowledge.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandConfig } from './template';

@Injectable()
export class ActionKnowledgeCreateExecutor implements NodeExecutor {
  readonly type = 'action.knowledge-create';
  readonly metadata: NodeMetadata = {
    type: 'action.knowledge-create',
    category: 'action',
    label: 'Knowledge-Eintrag erstellen',
    description: 'Speichert einen Knowledge-Eintrag im Run-Scope (project|customer).',
    allowedScopes: [WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      topic: z.string().min(1),
      content: z.string().min(1),
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    outputs: { knowledgeId: 'string' },
    branches: ['success', 'failure'],
  };

  constructor(private readonly knowledge: KnowledgeService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const expanded = expandConfig(ctx.config, ctx.runContext);
    const projectId =
      ctx.run.projectId instanceof Types.ObjectId ? ctx.run.projectId.toString() : undefined;
    const customerId =
      ctx.run.customerId instanceof Types.ObjectId ? ctx.run.customerId.toString() : undefined;
    try {
      const k = await this.knowledge.create({
        topic: String(expanded.topic),
        content: String(expanded.content),
        category: expanded.category as string | undefined,
        tags: (expanded.tags as string[]) ?? [],
        scope: projectId ? 'project' : 'customer',
        projectId,
        customerId,
      } as never);
      return {
        status: 'success',
        output: { knowledgeId: String((k as { _id: unknown })._id) },
      };
    } catch (err) {
      return {
        status: 'failed',
        error: { code: 'knowledge_create_failed', message: (err as Error).message },
      };
    }
  }
}
```

- [ ] **Step 5: `action-manual-create.executor.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Types } from 'mongoose';
import { ManualsService } from '../../manuals/manuals.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandConfig } from './template';

@Injectable()
export class ActionManualCreateExecutor implements NodeExecutor {
  readonly type = 'action.manual-create';
  readonly metadata: NodeMetadata = {
    type: 'action.manual-create',
    category: 'action',
    label: 'Manual-Seite anlegen',
    description: 'Erzeugt eine Manual-Seite im Run-Scope (project|customer, exklusiv).',
    allowedScopes: [WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      title: z.string().min(1),
      content: z.string().optional(),
      category: z.string().optional(),
      sortOrder: z.number().optional(),
    }),
    outputs: { manualId: 'string' },
    branches: ['success', 'failure'],
  };

  constructor(private readonly manuals: ManualsService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const expanded = expandConfig(ctx.config, ctx.runContext);
    const projectId =
      ctx.run.projectId instanceof Types.ObjectId ? ctx.run.projectId.toString() : undefined;
    const customerId =
      ctx.run.customerId instanceof Types.ObjectId ? ctx.run.customerId.toString() : undefined;
    try {
      const m = await this.manuals.create({
        title: String(expanded.title),
        content: expanded.content as string | undefined,
        category: expanded.category as string | undefined,
        sortOrder: expanded.sortOrder as number | undefined,
        projectId,
        customerId,
      } as never);
      return {
        status: 'success',
        output: { manualId: String((m as { _id: unknown })._id) },
      };
    } catch (err) {
      return {
        status: 'failed',
        error: { code: 'manual_create_failed', message: (err as Error).message },
      };
    }
  }
}
```

- [ ] **Step 6: `action-changelog-add.executor.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Types } from 'mongoose';
import { ChangelogService } from '../../changelog/changelog.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { expandConfig } from './template';

@Injectable()
export class ActionChangelogAddExecutor implements NodeExecutor {
  readonly type = 'action.changelog-add';
  readonly metadata: NodeMetadata = {
    type: 'action.changelog-add',
    category: 'action',
    label: 'Changelog-Eintrag anlegen',
    description: 'Fügt einen Changelog-Eintrag im Projekt-Scope hinzu.',
    allowedScopes: [WorkflowScope.PROJECT],
    configSchema: z.object({
      version: z.string().optional(),
      summary: z.string().optional(),
      changes: z.array(z.string()).min(1),
      component: z.string().optional(),
    }),
    outputs: { changelogId: 'string', version: 'string|null' },
    branches: ['success', 'failure'],
  };

  constructor(private readonly changelog: ChangelogService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const expanded = expandConfig(ctx.config, ctx.runContext);
    const projectId =
      ctx.run.projectId instanceof Types.ObjectId ? ctx.run.projectId.toString() : undefined;
    if (!projectId) {
      return { status: 'failed', error: { code: 'invalid_scope', message: 'changelog-add requires project scope' } };
    }
    try {
      const cl = await this.changelog.create({
        projectId,
        version: expanded.version as string | undefined,
        summary: expanded.summary as string | undefined,
        changes: (expanded.changes as string[]) ?? [],
        component: expanded.component as string | undefined,
      } as never);
      return {
        status: 'success',
        output: {
          changelogId: String((cl as { _id: unknown })._id),
          version: (cl as { version?: string }).version ?? null,
        },
      };
    } catch (err) {
      return {
        status: 'failed',
        error: { code: 'changelog_create_failed', message: (err as Error).message },
      };
    }
  }
}
```

- [ ] **Step 7: Build**

```bash
cd backend && npm run build
```

If any service signature mismatch surfaces, inspect that service's DTO file and adjust the call shape minimally — do not invent fields.

- [ ] **Step 8: Commit**

```bash
git add backend/src/workflows/nodes/action-todo-update.executor.ts \
  backend/src/workflows/nodes/action-todo-comment.executor.ts \
  backend/src/workflows/nodes/action-todo-link-milestone.executor.ts \
  backend/src/workflows/nodes/action-knowledge-create.executor.ts \
  backend/src/workflows/nodes/action-manual-create.executor.ts \
  backend/src/workflows/nodes/action-changelog-add.executor.ts
git commit -m "feat(workflows): mini action executors (todo update/comment/link, knowledge/manual/changelog) (T-252)"
```

---

## Task 7: `action.user-question` executor + engine branchMap support

**Files:**
- Create: `backend/src/workflows/nodes/action-user-question.executor.ts`
- Modify: `backend/src/workflows/engine/workflow-engine.service.ts`

- [ ] **Step 1: Write the executor**

```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';

@Injectable()
export class ActionUserQuestionExecutor implements NodeExecutor {
  readonly type = 'action.user-question';
  readonly metadata: NodeMetadata = {
    type: 'action.user-question',
    category: 'action',
    label: 'Rückfrage an User',
    description: 'Erzeugt eine Question und wartet auf die Antwort. Optional Branch-Mapping pro Option.',
    allowedScopes: [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      question: z.string().min(1),
      options: z.array(z.string()).optional(),
      branchMap: z.record(z.enum(['success', 'failure', 'custom'])).optional(),
      timeoutSeconds: z.number().int().positive().optional(),
    }),
    outputs: { answer: 'string', optionIndex: 'number|null' },
    branches: ['success', 'failure', 'custom'],
  };

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const question = String(ctx.config.question ?? '').trim();
    const options = (ctx.config.options as string[] | undefined) ?? [];
    if (!question) {
      return { status: 'failed', error: { code: 'invalid_config', message: 'question required' } };
    }
    const { refId } = await ctx.askUser(question, options);
    return { status: 'waiting', waitingFor: { type: 'question', refId } };
  }
}
```

- [ ] **Step 2: Update engine `handleQuestionAnswered` to honor branchMap**

Open `backend/src/workflows/engine/workflow-engine.service.ts`. Find the `handleQuestionAnswered` method (around the QUESTION_ANSWERED listener). The current implementation calls `this.applyResult(run, nodeRun, node, { status: 'success', output: { answer: payload.answer } })`.

Replace that call with:

```ts
    const cfg = (node.config ?? {}) as {
      branchMap?: Record<string, 'success' | 'failure' | 'custom'>;
      options?: string[];
    };
    const branch = cfg.branchMap?.[payload.answer];
    const optionIndex = cfg.options ? cfg.options.indexOf(payload.answer) : -1;
    await this.applyResult(run, nodeRun, node, {
      status: 'success',
      output: { answer: payload.answer, optionIndex: optionIndex >= 0 ? optionIndex : null },
      branch,
    });
```

- [ ] **Step 3: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/workflows/nodes/action-user-question.executor.ts \
  backend/src/workflows/engine/workflow-engine.service.ts
git commit -m "feat(workflows): action.user-question executor + branchMap resume (T-252)"
```

---

## Task 8: Condition ops helper + `control.condition` executor

**Files:**
- Create: `backend/src/workflows/nodes/condition-ops.ts`
- Create: `backend/src/workflows/nodes/control-condition.executor.ts`

- [ ] **Step 1: Write `condition-ops.ts`**

```ts
export type ConditionOp =
  | 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte'
  | 'contains' | 'exists' | 'truthy';

export function evalOp(lhs: unknown, op: ConditionOp, rhs?: unknown): boolean {
  switch (op) {
    case 'eq': return lhs === rhs;
    case 'ne': return lhs !== rhs;
    case 'gt':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs > rhs;
    case 'lt':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs < rhs;
    case 'gte':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs >= rhs;
    case 'lte':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs <= rhs;
    case 'contains':
      if (typeof lhs === 'string' && typeof rhs === 'string') return lhs.includes(rhs);
      if (Array.isArray(lhs)) return lhs.includes(rhs);
      return false;
    case 'exists':
      return lhs !== undefined && lhs !== null;
    case 'truthy':
      return Boolean(lhs);
    default:
      return false;
  }
}
```

- [ ] **Step 2: Write `control-condition.executor.ts`**

```ts
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
```

- [ ] **Step 3: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/workflows/nodes/condition-ops.ts \
  backend/src/workflows/nodes/control-condition.executor.ts
git commit -m "feat(workflows): control.condition executor with structured cases (T-252)"
```

---

## Task 9: `control.delay` executor

**Files:** Create `backend/src/workflows/nodes/control-delay.executor.ts`

- [ ] **Step 1: Write the executor**

```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';

const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

@Injectable()
export class ControlDelayExecutor implements NodeExecutor {
  readonly type = 'control.delay';
  readonly metadata: NodeMetadata = {
    type: 'control.delay',
    category: 'control',
    label: 'Wartezeit (Delay)',
    description: 'Pausiert den Run für delayMs Millisekunden oder bis zu einem ISO-Zeitpunkt. Crash-fest via WorkflowDelayScheduler.',
    allowedScopes: [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      delayMs: z.number().int().positive().max(MAX_DELAY_MS).optional(),
      until: z.string().datetime().optional(),
    }).refine((d) => (d.delayMs && !d.until) || (!d.delayMs && d.until), {
      message: 'control.delay needs exactly one of delayMs or until',
    }),
    outputs: { resumedAt: 'string', waitedMs: 'number' },
    branches: ['success'],
  };

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const cfg = ctx.config as { delayMs?: number; until?: string };
    const resumeAt = cfg.delayMs
      ? new Date(Date.now() + cfg.delayMs)
      : new Date(String(cfg.until));
    if (Number.isNaN(resumeAt.getTime())) {
      return { status: 'failed', error: { code: 'invalid_config', message: 'invalid resumeAt' } };
    }
    if (resumeAt.getTime() <= Date.now()) {
      // Already in the past — succeed immediately with zero wait.
      return { status: 'success', output: { resumedAt: new Date().toISOString(), waitedMs: 0 } };
    }
    return {
      status: 'waiting',
      waitingFor: { type: 'delay', resumeAt } as never,
    };
  }
}
```

- [ ] **Step 2: Build**

```bash
cd backend && npm run build
```

If TS rejects `{ type: 'delay'; resumeAt: Date }` against `NodeResult.waitingFor`, update `NodeResult` in `types.ts` to widen the union:

In `backend/src/workflows/engine/types.ts`, find:
```ts
  waitingFor?: { type: 'question'; refId: Types.ObjectId };
```
And replace with:
```ts
  waitingFor?:
    | { type: 'question'; refId: Types.ObjectId }
    | { type: 'delay'; resumeAt: Date };
```

Rebuild.

- [ ] **Step 3: Commit**

```bash
git add backend/src/workflows/nodes/control-delay.executor.ts backend/src/workflows/engine/types.ts
git commit -m "feat(workflows): control.delay executor with persistent waitingFor (T-252)"
```

---

## Task 10: Delay scheduler + engine `resumeDelayedNode`

**Files:**
- Create: `backend/src/workflows/engine/workflow-delay-scheduler.ts`
- Modify: `backend/src/workflows/engine/workflow-engine.service.ts`

- [ ] **Step 1: Extend engine `applyResult` for delay waits**

Open `backend/src/workflows/engine/workflow-engine.service.ts`. Find the `applyResult` method, specifically the `if (result.status === 'waiting') { ... }` block. Currently it sets `run.status = WorkflowRunStatus.WAITING_FOR_USER` unconditionally. Replace that block with:

```ts
    if (result.status === 'waiting') {
      nodeRun.status = WorkflowNodeRunStatus.WAITING;
      nodeRun.waitingFor = result.waitingFor;
      await nodeRun.save();
      const isTimer = result.waitingFor?.type === 'delay';
      run.status = isTimer ? WorkflowRunStatus.WAITING_FOR_TIMER : WorkflowRunStatus.WAITING_FOR_USER;
      await run.save();
      return;
    }
```

- [ ] **Step 2: Add `resumeDelayedNode` to engine**

In the same file, find the `handleQuestionAnswered` method (near the bottom of the class). Right after it, add:

```ts
  async resumeDelayedNode(nodeRunId: string | Types.ObjectId): Promise<void> {
    const nodeRun = await this.nodeRunModel.findById(nodeRunId).exec();
    if (!nodeRun) return;
    if (nodeRun.status !== WorkflowNodeRunStatus.WAITING) return;
    const wf = nodeRun.waitingFor as { type?: string; resumeAt?: Date } | undefined;
    if (wf?.type !== 'delay') return;

    const run = await this.runModel.findById(nodeRun.runId).exec();
    if (!run) return;
    const snapshot = run.definitionSnapshot as { nodes: WorkflowNode[]; edges: unknown[] };
    const node = snapshot.nodes.find((n) => n.id === nodeRun.nodeId);
    if (!node) return;

    const waitedMs = nodeRun.startedAt
      ? Date.now() - nodeRun.startedAt.getTime()
      : 0;

    nodeRun.set('waitingFor', undefined);
    run.status = WorkflowRunStatus.RUNNING;
    await run.save();
    await this.applyResult(run, nodeRun, node, {
      status: 'success',
      output: { resumedAt: new Date().toISOString(), waitedMs },
    });
  }
```

- [ ] **Step 3: Write `workflow-delay-scheduler.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  WorkflowNodeRun,
  WorkflowNodeRunDocument,
  WorkflowNodeRunStatus,
} from '../schemas/workflow-node-run.schema';
import { WorkflowEngineService } from './workflow-engine.service';

@Injectable()
export class WorkflowDelayScheduler {
  private readonly logger = new Logger(WorkflowDelayScheduler.name);

  constructor(
    @InjectModel(WorkflowNodeRun.name)
    private readonly nodeRunModel: Model<WorkflowNodeRunDocument>,
    private readonly engine: WorkflowEngineService,
  ) {}

  @Cron('*/15 * * * * *')
  async tick(): Promise<void> {
    if (process.env.WORKFLOW_SCHEDULER_DISABLED === 'true') return;
    const due = await this.nodeRunModel
      .find({
        'waitingFor.type': 'delay',
        'waitingFor.resumeAt': { $lte: new Date() },
        status: WorkflowNodeRunStatus.WAITING,
      })
      .limit(50)
      .exec();
    for (const nr of due) {
      try {
        await this.engine.resumeDelayedNode(nr._id as never);
      } catch (err) {
        this.logger.warn(`resumeDelayedNode failed for ${nr._id}: ${(err as Error).message}`);
      }
    }
  }
}
```

- [ ] **Step 4: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/workflows/engine/workflow-delay-scheduler.ts \
  backend/src/workflows/engine/workflow-engine.service.ts
git commit -m "feat(workflows): WorkflowDelayScheduler + engine resumeDelayedNode (T-252)"
```

---

## Task 11: Event-trigger executors + listener

**Files:**
- Create: `backend/src/workflows/nodes/trigger-project-event.executor.ts`
- Create: `backend/src/workflows/nodes/trigger-customer-event.executor.ts`
- Create: `backend/src/workflows/engine/workflow-event-listener.service.ts`
- Modify: `backend/src/workflows/workflows.service.ts` — propagate `dto.input` into `run.context.input`

- [ ] **Step 1: `trigger-project-event.executor.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';

const entityEnum = z.enum([
  'project', 'todo', 'session', 'knowledge', 'changelog', 'milestone', 'manual', 'research',
  'notification', 'environment', 'secret', 'schema', 'dependency', 'feature', 'soul',
  'commit', 'recurring-task', 'snippet', 'attachment', 'log', 'release', 'chat',
  'workspace', 'customer-project', 'contact', 'customer', 'healthcheck', 'workflow-definition', 'workflow-run', '*',
]);
const actionEnum = z.enum(['created', 'updated', 'deleted', '*']);

@Injectable()
export class TriggerProjectEventExecutor implements NodeExecutor {
  readonly type = 'trigger.project_event';
  readonly metadata: NodeMetadata = {
    type: 'trigger.project_event',
    category: 'trigger',
    label: 'Projekt-Event-Trigger',
    description: 'Workflow startet, wenn ein Projekt-Event (Entity-Mutation) matched.',
    allowedScopes: [WorkflowScope.PROJECT],
    configSchema: z.object({
      entity: entityEnum,
      action: actionEnum,
      filter: z.object({
        tag: z.string().optional(),
        status: z.string().optional(),
        milestoneId: z.string().optional(),
      }).optional(),
    }),
    outputs: { event: 'object' },
    branches: ['success'],
  };

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const input = (ctx.runContext as { input?: { event?: unknown } }).input;
    return { status: 'success', output: { event: input?.event ?? null } };
  }
}
```

- [ ] **Step 2: `trigger-customer-event.executor.ts`**

Same code as Step 1 but:
- `readonly type = 'trigger.customer_event';`
- `metadata.type = 'trigger.customer_event'`
- `metadata.label = 'Kunden-Event-Trigger'`
- `metadata.description = 'Workflow startet, wenn ein Customer-Event (Entity-Mutation) matched.'`
- `metadata.allowedScopes = [WorkflowScope.CUSTOMER]`

Otherwise identical.

- [ ] **Step 3: `workflow-event-listener.service.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  WorkflowDefinition,
  WorkflowDefinitionDocument,
  WorkflowScope,
  WorkflowStatus,
} from '../schemas/workflow-definition.schema';
import { WorkflowsService } from '../workflows.service';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../../events/project-event';

@Injectable()
export class WorkflowEventListener {
  private readonly logger = new Logger(WorkflowEventListener.name);

  constructor(
    @InjectModel(WorkflowDefinition.name)
    private readonly definitionModel: Model<WorkflowDefinitionDocument>,
    private readonly workflowsService: WorkflowsService,
  ) {}

  @OnEvent(PROJECT_CHANGED)
  async handleProjectChange(payload: ProjectChangeEvent): Promise<void> {
    if (!payload.projectId && !payload.customerId) return;
    const isProject = !!payload.projectId;
    const scope = isProject ? WorkflowScope.PROJECT : WorkflowScope.CUSTOMER;
    const triggerType = isProject ? 'trigger.project_event' : 'trigger.customer_event';

    const filter: Record<string, unknown> = {
      scope,
      status: WorkflowStatus.ACTIVE,
      'nodes.type': triggerType,
    };
    if (isProject) filter.projectId = new Types.ObjectId(payload.projectId!);
    else filter.customerId = new Types.ObjectId(payload.customerId!);

    const candidates = await this.definitionModel.find(filter).exec();
    for (const def of candidates) {
      for (const node of def.nodes) {
        if (node.type !== triggerType) continue;
        if (!this.matches(node.config as Record<string, unknown>, payload)) continue;
        try {
          await this.workflowsService.startRun({
            definitionId: (def._id as { toString(): string }).toString(),
            triggeredBy: { type: 'event' },
            input: { event: payload, matchedNodeId: node.id },
          } as never);
        } catch (err) {
          this.logger.warn(`event-trigger failed for ${def.name}: ${(err as Error).message}`);
        }
      }
    }
  }

  private matches(config: Record<string, unknown>, ev: ProjectChangeEvent): boolean {
    const wantEntity = (config.entity as string) ?? '*';
    const wantAction = (config.action as string) ?? '*';
    if (wantEntity !== '*' && wantEntity !== ev.entity) return false;
    if (wantAction !== '*' && wantAction !== ev.action) return false;
    return true;
  }
}
```

- [ ] **Step 4: Update `WorkflowsService.startRun` to write `input` into `context`**

Open `backend/src/workflows/workflows.service.ts`. Find the `startRun` method. In the `runModel.create({...})` call, find the line `context: { nodes: {} }` (added in T-250 Task 14). Replace it with:

```ts
      context: { nodes: {}, input: dto.input ?? {} },
```

- [ ] **Step 5: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/workflows/nodes/trigger-project-event.executor.ts \
  backend/src/workflows/nodes/trigger-customer-event.executor.ts \
  backend/src/workflows/engine/workflow-event-listener.service.ts \
  backend/src/workflows/workflows.service.ts
git commit -m "feat(workflows): event-trigger nodes + PROJECT_CHANGED listener + input→context (T-252)"
```

---

## Task 12: Activation-time zod schema validation

**Files:** Modify `backend/src/workflows/workflows.service.ts`

Today `updateDefinition` runs `validateGraph` + `workflowSecurityIssues` when transitioning to ACTIVE. Add a third check: per-node config schema validation via `NodeRegistry.getMetadata(type).configSchema.safeParse(config)`.

- [ ] **Step 1: Inject `NodeRegistry`**

Add to the imports at the top:
```ts
import { NodeRegistry } from './engine/node-registry';
```

Add to the constructor parameter list:
```ts
    private readonly nodeRegistry: NodeRegistry,
```

- [ ] **Step 2: Add schema-validation in `updateDefinition`**

Inside the `if (existing.status === WorkflowStatus.ACTIVE) { ... }` block, AFTER the existing `workflowSecurityIssues` check, add:

```ts
      const schemaIssues: string[] = [];
      for (const node of existing.nodes) {
        if (!this.nodeRegistry.has(node.type)) continue; // unknown types caught by security check
        const schema = this.nodeRegistry.getMetadata(node.type).configSchema;
        const parsed = schema.safeParse(node.config ?? {});
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            schemaIssues.push(`node "${node.id}" (${node.type}) config.${issue.path.join('.')}: ${issue.message}`);
          }
        }
      }
      if (schemaIssues.length > 0) {
        throw new BadRequestException(`Workflow cannot be activated: ${schemaIssues.join('; ')}`);
      }
```

- [ ] **Step 3: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/workflows/workflows.service.ts
git commit -m "feat(workflows): zod schema validation per node at activation (T-252)"
```

---

## Task 13: Node-types REST endpoint + MCP tool

**Files:**
- Create: `backend/src/workflows/workflow-node-types.controller.ts`
- Modify: `backend/src/mcp-tools.ts` (add `workflow_node_types_list` tool)

- [ ] **Step 1: Write the controller**

```ts
import { Controller, Get } from '@nestjs/common';
import { NodeRegistry } from './engine/node-registry';
import { toPublicMetadata, NodeMetadataPublic } from './engine/node-metadata';

@Controller('workflows/node-types')
export class WorkflowNodeTypesController {
  constructor(private readonly registry: NodeRegistry) {}

  @Get()
  list(): NodeMetadataPublic[] {
    return this.registry.listMetadata().map(toPublicMetadata);
  }
}
```

(Will be wired in the module step. Don't add `controllers: [WorkflowNodeTypesController]` to the module yet — that happens in Task 16.)

- [ ] **Step 2: Add MCP tool**

Open `backend/src/mcp-tools.ts`. Find the existing `workflow_node_run_list` tool definition. AFTER its closing `},`, INSERT:

```ts
  {
    name: 'workflow_node_types_list',
    description: 'Returns the catalog of registered workflow node types with their JSON-Schema configs, outputs, scopes and branches. Read-only — used by UI and agents constructing workflows.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
```

In the handler switch (around line 4640-4650 where `case 'workflow_node_run_list':` lives), AFTER its `break;` INSERT:

```ts
        case 'workflow_node_types_list': {
          // NodeRegistry exposes metadata via WorkflowsService surface? Currently it's a separate provider.
          // We'll wire it through the services bag in Task 16; for now read via NodeRegistry directly.
          const registry = (services as unknown as { nodeRegistry?: { listMetadata: () => unknown[] } }).nodeRegistry;
          if (!registry) {
            result = [];
          } else {
            const { toPublicMetadata } = await import('./workflows/engine/node-metadata');
            result = (registry.listMetadata() as never[]).map((m) => toPublicMetadata(m as never));
          }
          break;
        }
```

(The Task 16 wiring step will add `nodeRegistry` to the McpToolsServices.)

- [ ] **Step 3: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/workflows/workflow-node-types.controller.ts backend/src/mcp-tools.ts
git commit -m "feat(workflows): node-types REST endpoint + workflow_node_types_list MCP tool (T-252)"
```

---

## Task 14: Workflow-agent settings + DTOs

**Files:**
- Create: `backend/src/workflows/dto/workflow-agent.dto.ts`
- Create: `backend/src/workflows/workflow-agent.service.ts` (skeleton — full LLM logic in Task 15)

- [ ] **Step 1: DTOs**

```ts
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min, Max } from 'class-validator';

export type WorkflowAgentProvider = 'lmstudio' | 'openai-compatible' | 'openai' | 'anthropic';

export class UpdateWorkflowAgentConfigDto {
  @IsEnum(['lmstudio', 'openai-compatible', 'openai', 'anthropic'])
  provider: WorkflowAgentProvider;

  @IsString()
  url: string;

  @IsString()
  model: string;

  /**
   * undefined → keep existing; '' → delete; non-empty → encrypt and store.
   * Mirrors ChatLlmService.setEndpoints semantics.
   */
  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsBoolean()
  toolsEnabled: boolean;

  @IsInt()
  @Min(1)
  @Max(20)
  maxToolIterations: number;
}

export interface WorkflowAgentConfigPublic {
  provider: WorkflowAgentProvider;
  url: string;
  model: string;
  hasApiKey: boolean;
  toolsEnabled: boolean;
  maxToolIterations: number;
}
```

- [ ] **Step 2: Service skeleton (settings only — LLM call comes in Task 15)**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { EncryptionService } from '../common/encryption.service';
import { UpdateWorkflowAgentConfigDto, WorkflowAgentConfigPublic, WorkflowAgentProvider } from './dto/workflow-agent.dto';

const SETTING_KEY = 'workflow_agent_endpoint_v1';

interface StoredEndpoint {
  provider: WorkflowAgentProvider;
  url: string;
  model: string;
  apiKeyEncrypted?: string;
  toolsEnabled: boolean;
  maxToolIterations: number;
}

export interface WorkflowAgentEndpoint {
  provider: WorkflowAgentProvider;
  url: string;
  model: string;
  apiKey?: string;
  toolsEnabled: boolean;
  maxToolIterations: number;
}

@Injectable()
export class WorkflowAgentService {
  private readonly logger = new Logger(WorkflowAgentService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly encryption: EncryptionService,
  ) {}

  async getConfig(): Promise<WorkflowAgentConfigPublic | null> {
    const raw = await this.settings.get(SETTING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredEndpoint;
    return {
      provider: parsed.provider,
      url: parsed.url,
      model: parsed.model,
      hasApiKey: !!parsed.apiKeyEncrypted && parsed.apiKeyEncrypted.length > 0,
      toolsEnabled: parsed.toolsEnabled,
      maxToolIterations: parsed.maxToolIterations,
    };
  }

  async setConfig(dto: UpdateWorkflowAgentConfigDto): Promise<void> {
    const previous = await this.loadEndpoint();
    let apiKeyEncrypted: string | undefined;
    if (dto.apiKey === undefined) {
      apiKeyEncrypted = previous?.apiKey ? this.encryption.encrypt(previous.apiKey) : undefined;
    } else if (dto.apiKey === '') {
      apiKeyEncrypted = undefined;
    } else {
      apiKeyEncrypted = this.encryption.encrypt(dto.apiKey);
    }
    const stored: StoredEndpoint = {
      provider: dto.provider,
      url: dto.url,
      model: dto.model,
      apiKeyEncrypted,
      toolsEnabled: dto.toolsEnabled,
      maxToolIterations: dto.maxToolIterations,
    };
    await this.settings.set(SETTING_KEY, JSON.stringify(stored));
  }

  async loadEndpoint(): Promise<WorkflowAgentEndpoint | null> {
    const raw = await this.settings.get(SETTING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredEndpoint;
    return {
      provider: parsed.provider,
      url: parsed.url,
      model: parsed.model,
      apiKey: parsed.apiKeyEncrypted ? this.encryption.decrypt(parsed.apiKeyEncrypted) : undefined,
      toolsEnabled: parsed.toolsEnabled,
      maxToolIterations: parsed.maxToolIterations,
    };
  }
}
```

- [ ] **Step 3: Build**

If `EncryptionService` import path is `../common/encryption.service` mismatches, look at how `ChatLlmService` imports it and use the same path.

```bash
cd backend && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/workflows/dto/workflow-agent.dto.ts \
  backend/src/workflows/workflow-agent.service.ts
git commit -m "feat(workflows): workflow-agent settings storage skeleton (T-252)"
```

---

## Task 15: `WorkflowAgentService.run` — LLM call + tool loop

**Files:**
- Modify: `backend/src/workflows/workflow-agent.service.ts`
- Create: `backend/src/workflows/nodes/agent-task.executor.ts`

This is the biggest single task. Implement the non-streaming LLM dispatch for OpenAI-protocol providers (lmstudio, openai-compatible, openai) and Anthropic, with a tool-call loop driven by `ChatToolsService`.

- [ ] **Step 1: Inject `ChatToolsService` into `WorkflowAgentService`**

Append to the constructor in `workflow-agent.service.ts`:
```ts
    private readonly chatTools: import('../chat/chat-tools').ChatToolsService,
```

And at the top, add the explicit import:
```ts
import { ChatToolsService } from '../chat/chat-tools';
import { ALL_TOOL_NAMES, WRITE_TOOL_NAMES, TOOL_DEFINITIONS } from '../chat/chat-tools';
```

(Skip the `import type` form — we need runtime access.)

- [ ] **Step 2: Add helper `effectiveAllowlist`**

In `WorkflowAgentService`, add:

```ts
  private effectiveAllowlist(nodeAllowlist: string[]): string[] {
    const envCsv = process.env.WORKFLOW_AGENT_TOOL_ALLOWLIST ?? '';
    const envExplicit = new Set(envCsv.split(',').map((s) => s.trim()).filter(Boolean));
    const suffixOk = (name: string) => /_(get|list|search)$/.test(name);
    const globalAllowed = new Set(
      ALL_TOOL_NAMES.filter((name) => envExplicit.has(name) || suffixOk(name)),
    );
    return nodeAllowlist.filter((name) => globalAllowed.has(name));
  }
```

- [ ] **Step 3: Add `run` method (OpenAI-protocol branch)**

```ts
  async run(input: {
    prompt: string;
    systemPrompt?: string;
    runContext: Record<string, unknown>;
    allowedTools: string[];
    callerScope: { projectId?: string; customerId?: string };
    timeoutMs: number;
    maxToolIterations?: number;
  }): Promise<{
    response: string;
    iterations: number;
    toolCalls: Array<{ tool: string; args: unknown; result: unknown }>;
    tokensIn?: number;
    tokensOut?: number;
    model: string;
  }> {
    const endpoint = await this.loadEndpoint();
    if (!endpoint) throw new Error('no_agent_endpoint');

    const allowlist = endpoint.toolsEnabled ? this.effectiveAllowlist(input.allowedTools) : [];
    const maxIter = input.maxToolIterations ?? endpoint.maxToolIterations;

    if (endpoint.provider === 'anthropic') {
      return this.runAnthropic(endpoint, input, allowlist, maxIter);
    }
    return this.runOpenAI(endpoint, input, allowlist, maxIter);
  }

  private async runOpenAI(
    endpoint: WorkflowAgentEndpoint,
    input: Parameters<WorkflowAgentService['run']>[0],
    allowlist: string[],
    maxIter: number,
  ): Promise<Awaited<ReturnType<WorkflowAgentService['run']>>> {
    const messages: Array<Record<string, unknown>> = [];
    if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
    messages.push({ role: 'user', content: input.prompt });

    const toolsForLlm = allowlist
      .filter((name) => TOOL_DEFINITIONS[name])
      .map((name) => ({ type: 'function' as const, function: TOOL_DEFINITIONS[name] }));

    const toolCalls: Array<{ tool: string; args: unknown; result: unknown }> = [];
    let totalIn = 0;
    let totalOut = 0;
    const deadline = Date.now() + input.timeoutMs;

    for (let iter = 0; iter < maxIter; iter++) {
      if (Date.now() > deadline) throw new Error('timeout');

      const body: Record<string, unknown> = {
        model: endpoint.model,
        messages,
        stream: false,
      };
      if (toolsForLlm.length > 0) body.tools = toolsForLlm;

      const url = endpoint.url.replace(/\/$/, '') + '/v1/chat/completions';
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;

      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`llm_error_${res.status}: ${await res.text().catch(() => '')}`);
      const json = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name: string; arguments: string } }> };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = json.choices?.[0]?.message;
      if (json.usage?.prompt_tokens) totalIn += json.usage.prompt_tokens;
      if (json.usage?.completion_tokens) totalOut += json.usage.completion_tokens;

      if (!choice) throw new Error('llm_error_no_choice');

      const tcs = choice.tool_calls ?? [];
      if (tcs.length === 0) {
        return {
          response: choice.content ?? '',
          iterations: iter + 1,
          toolCalls,
          tokensIn: totalIn || undefined,
          tokensOut: totalOut || undefined,
          model: endpoint.model,
        };
      }

      messages.push({
        role: 'assistant',
        content: choice.content ?? null,
        tool_calls: tcs,
      });

      for (const tc of tcs) {
        const name = tc.function?.name ?? '';
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        if (!allowlist.includes(name)) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id ?? name,
            content: JSON.stringify({ success: false, error: `tool "${name}" not in allowlist` }),
          });
          toolCalls.push({ tool: name, args, result: { error: 'not_in_allowlist' } });
          continue;
        }
        const result = await this.chatTools.execute(
          name,
          args,
          { projectId: input.callerScope.projectId ?? null },
          allowlist,
        );
        toolCalls.push({ tool: name, args, result });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id ?? name,
          content: JSON.stringify(result),
        });
      }
    }
    throw new Error('tool_loop_limit');
  }
```

- [ ] **Step 4: Add `runAnthropic`**

```ts
  private async runAnthropic(
    endpoint: WorkflowAgentEndpoint,
    input: Parameters<WorkflowAgentService['run']>[0],
    allowlist: string[],
    maxIter: number,
  ): Promise<Awaited<ReturnType<WorkflowAgentService['run']>>> {
    type AnthMsg = { role: 'user' | 'assistant'; content: unknown };
    const messages: AnthMsg[] = [{ role: 'user', content: input.prompt }];
    const tools = allowlist
      .filter((name) => TOOL_DEFINITIONS[name])
      .map((name) => ({
        name,
        description: TOOL_DEFINITIONS[name].description,
        input_schema: TOOL_DEFINITIONS[name].parameters,
      }));

    const toolCalls: Array<{ tool: string; args: unknown; result: unknown }> = [];
    let totalIn = 0;
    let totalOut = 0;
    const deadline = Date.now() + input.timeoutMs;

    for (let iter = 0; iter < maxIter; iter++) {
      if (Date.now() > deadline) throw new Error('timeout');

      const body: Record<string, unknown> = {
        model: endpoint.model,
        max_tokens: 4096,
        messages,
      };
      if (input.systemPrompt) body.system = input.systemPrompt;
      if (tools.length > 0) body.tools = tools;

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (endpoint.apiKey) headers['x-api-key'] = endpoint.apiKey;

      const res = await fetch(`${endpoint.url.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`llm_error_${res.status}: ${await res.text().catch(() => '')}`);
      const json = (await res.json()) as {
        content?: Array<{ type: 'text' | 'tool_use'; text?: string; id?: string; name?: string; input?: unknown }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        stop_reason?: string;
      };
      if (json.usage?.input_tokens) totalIn += json.usage.input_tokens;
      if (json.usage?.output_tokens) totalOut += json.usage.output_tokens;

      const blocks = json.content ?? [];
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      const textParts = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');

      if (toolUses.length === 0) {
        return {
          response: textParts,
          iterations: iter + 1,
          toolCalls,
          tokensIn: totalIn || undefined,
          tokensOut: totalOut || undefined,
          model: endpoint.model,
        };
      }

      messages.push({ role: 'assistant', content: blocks });
      const userContent: unknown[] = [];
      for (const tu of toolUses) {
        const name = tu.name ?? '';
        const args = (tu.input as Record<string, unknown>) ?? {};
        let result: unknown;
        if (!allowlist.includes(name)) {
          result = { success: false, error: `tool "${name}" not in allowlist` };
        } else {
          result = await this.chatTools.execute(
            name,
            args,
            { projectId: input.callerScope.projectId ?? null },
            allowlist,
          );
        }
        toolCalls.push({ tool: name, args, result });
        userContent.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: 'user', content: userContent });
    }
    throw new Error('tool_loop_limit');
  }
```

- [ ] **Step 5: Write `agent-task.executor.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Types } from 'mongoose';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { WorkflowAgentService } from '../workflow-agent.service';
import { expandConfig } from './template';

@Injectable()
export class AgentTaskExecutor implements NodeExecutor {
  readonly type = 'agent.task';
  readonly metadata: NodeMetadata = {
    type: 'agent.task',
    category: 'agent',
    label: 'Agent-Task',
    description: 'Ruft den konfigurierten Workflow-Agent-LLM mit Prompt + optionalen MCP-Tools. Allowlist gilt pro Node.',
    allowedScopes: [WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema: z.object({
      prompt: z.string().min(1),
      systemPrompt: z.string().optional(),
      allowedTools: z.array(z.string()).optional(),
      timeoutMs: z.number().int().positive().max(600000).optional(),
      maxToolIterations: z.number().int().positive().max(20).optional(),
    }),
    outputs: {
      response: 'string',
      iterations: 'number',
      toolCalls: 'array',
      tokensIn: 'number|null',
      tokensOut: 'number|null',
      model: 'string',
    },
    branches: ['success', 'failure'],
  };

  constructor(private readonly agent: WorkflowAgentService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const expanded = expandConfig(ctx.config, ctx.runContext);
    const projectId =
      ctx.run.projectId instanceof Types.ObjectId ? ctx.run.projectId.toString() : undefined;
    const customerId =
      ctx.run.customerId instanceof Types.ObjectId ? ctx.run.customerId.toString() : undefined;
    try {
      const out = await this.agent.run({
        prompt: String(expanded.prompt),
        systemPrompt: expanded.systemPrompt as string | undefined,
        runContext: ctx.runContext,
        allowedTools: (expanded.allowedTools as string[]) ?? [],
        callerScope: { projectId, customerId },
        timeoutMs: (expanded.timeoutMs as number) ?? 60000,
        maxToolIterations: expanded.maxToolIterations as number | undefined,
      });
      return {
        status: 'success',
        output: {
          response: out.response,
          iterations: out.iterations,
          toolCalls: out.toolCalls,
          tokensIn: out.tokensIn ?? null,
          tokensOut: out.tokensOut ?? null,
          model: out.model,
        },
      };
    } catch (err) {
      const msg = (err as Error).message ?? 'agent_failed';
      const code = msg.startsWith('llm_error_') ? 'llm_error'
        : msg === 'timeout' ? 'timeout'
        : msg === 'no_agent_endpoint' ? 'no_agent_endpoint'
        : msg === 'tool_loop_limit' ? 'tool_loop_limit'
        : 'agent_failed';
      return { status: 'failed', error: { code, message: msg } };
    }
  }
}
```

- [ ] **Step 6: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/workflows/workflow-agent.service.ts \
  backend/src/workflows/nodes/agent-task.executor.ts
git commit -m "feat(workflows): WorkflowAgentService LLM + tool-loop, agent.task executor (T-252)"
```

---

## Task 16: Workflow-agent controller + module wiring

**Files:**
- Create: `backend/src/workflows/workflow-agent.controller.ts`
- Modify: `backend/src/workflows/workflows.module.ts`
- Modify: `backend/src/mcp-tools.ts` + `backend/src/mcp-server.ts` + `backend/src/main.ts` — add `nodeRegistry` to services bag

- [ ] **Step 1: Controller**

```ts
import { Body, Controller, Get, Put } from '@nestjs/common';
import { WorkflowAgentService } from './workflow-agent.service';
import { UpdateWorkflowAgentConfigDto, WorkflowAgentConfigPublic } from './dto/workflow-agent.dto';

@Controller('workflows/agent-config')
export class WorkflowAgentController {
  constructor(private readonly agent: WorkflowAgentService) {}

  @Get()
  async get(): Promise<WorkflowAgentConfigPublic | null> {
    return this.agent.getConfig();
  }

  @Put()
  async set(@Body() dto: UpdateWorkflowAgentConfigDto): Promise<{ ok: true }> {
    await this.agent.setConfig(dto);
    return { ok: true };
  }
}
```

- [ ] **Step 2: Module wiring**

Open `backend/src/workflows/workflows.module.ts`. Add all the new imports + register them.

Add imports at the top:
```ts
import { WorkflowEventListener } from './engine/workflow-event-listener.service';
import { WorkflowDelayScheduler } from './engine/workflow-delay-scheduler';
import { WorkflowNodeTypesController } from './workflow-node-types.controller';
import { WorkflowAgentService } from './workflow-agent.service';
import { WorkflowAgentController } from './workflow-agent.controller';
import { ActionTodoUpdateExecutor } from './nodes/action-todo-update.executor';
import { ActionTodoCommentExecutor } from './nodes/action-todo-comment.executor';
import { ActionTodoLinkMilestoneExecutor } from './nodes/action-todo-link-milestone.executor';
import { ActionKnowledgeCreateExecutor } from './nodes/action-knowledge-create.executor';
import { ActionManualCreateExecutor } from './nodes/action-manual-create.executor';
import { ActionChangelogAddExecutor } from './nodes/action-changelog-add.executor';
import { ActionUserQuestionExecutor } from './nodes/action-user-question.executor';
import { ControlConditionExecutor } from './nodes/control-condition.executor';
import { ControlDelayExecutor } from './nodes/control-delay.executor';
import { TriggerProjectEventExecutor } from './nodes/trigger-project-event.executor';
import { TriggerCustomerEventExecutor } from './nodes/trigger-customer-event.executor';
import { AgentTaskExecutor } from './nodes/agent-task.executor';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ManualsModule } from '../manuals/manuals.module';
import { ChangelogModule } from '../changelog/changelog.module';
import { ChatModule } from '../chat/chat.module';
import { SettingsModule } from '../settings/settings.module';
import { CommonModule } from '../common/common.module';
```

(Inspect existing module imports — if `KnowledgeModule`, `ManualsModule`, `ChangelogModule` don't `export` their services, you'll need to add the exports in each module file. Mirror what `TodosModule` does.)

Update the `@Module({...})` definition:
- `imports`: add `KnowledgeModule`, `ManualsModule`, `ChangelogModule`, `ChatModule`, `SettingsModule`, `CommonModule`
- `controllers`: add `WorkflowNodeTypesController`, `WorkflowAgentController`
- `providers`: add ALL new providers and executors:
  ```
  WorkflowEventListener, WorkflowDelayScheduler, WorkflowAgentService,
  ActionTodoUpdateExecutor, ActionTodoCommentExecutor, ActionTodoLinkMilestoneExecutor,
  ActionKnowledgeCreateExecutor, ActionManualCreateExecutor, ActionChangelogAddExecutor,
  ActionUserQuestionExecutor,
  ControlConditionExecutor, ControlDelayExecutor,
  TriggerProjectEventExecutor, TriggerCustomerEventExecutor,
  AgentTaskExecutor,
  ```

In the existing `WorkflowsModule` class constructor, inject all new executors (mirror the T-250 pattern):
```ts
    private readonly actionTodoUpdate: ActionTodoUpdateExecutor,
    private readonly actionTodoComment: ActionTodoCommentExecutor,
    private readonly actionTodoLinkMilestone: ActionTodoLinkMilestoneExecutor,
    private readonly actionKnowledgeCreate: ActionKnowledgeCreateExecutor,
    private readonly actionManualCreate: ActionManualCreateExecutor,
    private readonly actionChangelogAdd: ActionChangelogAddExecutor,
    private readonly actionUserQuestion: ActionUserQuestionExecutor,
    private readonly controlCondition: ControlConditionExecutor,
    private readonly controlDelay: ControlDelayExecutor,
    private readonly triggerProjectEvent: TriggerProjectEventExecutor,
    private readonly triggerCustomerEvent: TriggerCustomerEventExecutor,
    private readonly agentTask: AgentTaskExecutor,
```

In `onModuleInit`, register them:
```ts
    this.registry.register(this.actionTodoUpdate);
    this.registry.register(this.actionTodoComment);
    this.registry.register(this.actionTodoLinkMilestone);
    this.registry.register(this.actionKnowledgeCreate);
    this.registry.register(this.actionManualCreate);
    this.registry.register(this.actionChangelogAdd);
    this.registry.register(this.actionUserQuestion);
    this.registry.register(this.controlCondition);
    this.registry.register(this.controlDelay);
    this.registry.register(this.triggerProjectEvent);
    this.registry.register(this.triggerCustomerEvent);
    this.registry.register(this.agentTask);
```

Add `WorkflowAgentService` to `exports` so other modules (and the MCP-tools registration) can reach it.

- [ ] **Step 3: Add `nodeRegistry` to the MCP services bag**

In `backend/src/mcp-tools.ts`, find the `McpToolsServices` interface. AFTER `workflowEngineService: WorkflowEngineService;` ADD:
```ts
  nodeRegistry: NodeRegistry;
```

Add the import near `WorkflowEngineService`:
```ts
import { NodeRegistry } from './workflows/engine/node-registry';
```

In the destructure block around line 2900, ADD `nodeRegistry,` to the list.

In the `case 'workflow_node_types_list'` handler (added in Task 13), REPLACE the dynamic-services lookup with a direct call:
```ts
        case 'workflow_node_types_list': {
          const { toPublicMetadata } = await import('./workflows/engine/node-metadata');
          result = nodeRegistry.listMetadata().map(toPublicMetadata);
          break;
        }
```

In `backend/src/mcp-server.ts` and `backend/src/main.ts`, add `NodeRegistry` import + `nodeRegistry: app.get(NodeRegistry),` line in the services-bag literal (mirror the `WorkflowEngineService` line added during T-250 Task 17).

- [ ] **Step 4: Build**

```bash
cd backend && npm run build
```

If `KnowledgeService`/`ManualsService`/`ChangelogService` aren't exported from their modules, the build will fail. Add `exports: [XxxService]` to each module file (smallest change).

- [ ] **Step 5: Commit**

```bash
git add backend/src/workflows/workflow-agent.controller.ts \
  backend/src/workflows/workflows.module.ts \
  backend/src/mcp-tools.ts \
  backend/src/mcp-server.ts \
  backend/src/main.ts
# only add downstream module exports if you had to touch them:
# git add backend/src/knowledge/knowledge.module.ts backend/src/manuals/manuals.module.ts backend/src/changelog/changelog.module.ts
git commit -m "feat(workflows): wire agent + 11 new node executors + node-types registry (T-252)"
```

---

## Task 17: Pure-logic check script

**Files:**
- Create: `backend/scripts/workflow-nodes-units-check.cjs`
- Modify: `backend/package.json`

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
/*
 * Pure-logic regression check for the T-252 node catalog.
 * Loads compiled helpers from dist/ and exercises them.
 * Run with `npm run check:workflow-nodes-units` from backend/ after a build.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const tmpl = loadCompiled('workflows/nodes/template.js');
const condOps = loadCompiled('workflows/nodes/condition-ops.js');
const nodeMetadata = loadCompiled('workflows/engine/node-metadata.js');

let failures = 0;
let total = 0;

function check(label, fn) {
  total += 1;
  try {
    fn();
    console.log(`✓ ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err.message || err}`);
  }
}

// ---------- lookupPath ----------
check('lookupPath: top-level', () => {
  assert.equal(tmpl.lookupPath('name', { name: 'Anna' }), 'Anna');
});
check('lookupPath: nested', () => {
  assert.equal(tmpl.lookupPath('nodes.x.id', { nodes: { x: { id: 'abc' } } }), 'abc');
});
check('lookupPath: missing returns undefined', () => {
  assert.equal(tmpl.lookupPath('missing.thing', {}), undefined);
});

// ---------- condition-ops ----------
check('evalOp eq truthy', () => assert.equal(condOps.evalOp(5, 'eq', 5), true));
check('evalOp eq falsy', () => assert.equal(condOps.evalOp(5, 'eq', 6), false));
check('evalOp ne truthy', () => assert.equal(condOps.evalOp(5, 'ne', 6), true));
check('evalOp gt numeric', () => assert.equal(condOps.evalOp(10, 'gt', 5), true));
check('evalOp gt rejects strings', () => assert.equal(condOps.evalOp('a', 'gt', 'b'), false));
check('evalOp lt numeric', () => assert.equal(condOps.evalOp(3, 'lt', 5), true));
check('evalOp gte / lte edges', () => {
  assert.equal(condOps.evalOp(5, 'gte', 5), true);
  assert.equal(condOps.evalOp(5, 'lte', 5), true);
});
check('evalOp contains on string', () => assert.equal(condOps.evalOp('hello', 'contains', 'ell'), true));
check('evalOp contains on array', () => assert.equal(condOps.evalOp(['a', 'b'], 'contains', 'b'), true));
check('evalOp exists', () => {
  assert.equal(condOps.evalOp(0, 'exists'), true);   // 0 exists
  assert.equal(condOps.evalOp(null, 'exists'), false);
  assert.equal(condOps.evalOp(undefined, 'exists'), false);
});
check('evalOp truthy', () => {
  assert.equal(condOps.evalOp(0, 'truthy'), false);
  assert.equal(condOps.evalOp('x', 'truthy'), true);
  assert.equal(condOps.evalOp([], 'truthy'), true);  // empty array is truthy in JS
});

// ---------- NodeMetadata + zod schemas ----------
const allExecutors = [
  ['workflows/nodes/trigger-manual.executor.js', 'TriggerManualExecutor', { config: {}, invalid: { extra: true } }],
  ['workflows/nodes/trigger-schedule.executor.js', 'TriggerScheduleExecutor', { config: {}, invalid: null }],
  ['workflows/nodes/action-log.executor.js', 'ActionLogExecutor', { config: { message: 'hi' }, invalid: { message: 42 } }],
  ['workflows/nodes/action-todo-create.executor.js', 'ActionTodoCreateExecutor', { config: { title: 't' }, invalid: { title: '' } }],
  ['workflows/nodes/action-notify.executor.js', 'ActionNotifyExecutor', { config: { title: 'n' }, invalid: { title: '' } }],
  ['workflows/nodes/action-todo-update.executor.js', 'ActionTodoUpdateExecutor', { config: { todoId: 'abc' }, invalid: { todoId: '' } }],
  ['workflows/nodes/action-todo-comment.executor.js', 'ActionTodoCommentExecutor', { config: { todoId: 'a', text: 'x' }, invalid: { todoId: 'a' } }],
  ['workflows/nodes/action-todo-link-milestone.executor.js', 'ActionTodoLinkMilestoneExecutor', { config: { todoId: 'a', milestoneId: 'b' }, invalid: { todoId: '', milestoneId: 'b' } }],
  ['workflows/nodes/action-knowledge-create.executor.js', 'ActionKnowledgeCreateExecutor', { config: { topic: 't', content: 'c' }, invalid: { topic: 't' } }],
  ['workflows/nodes/action-manual-create.executor.js', 'ActionManualCreateExecutor', { config: { title: 't' }, invalid: { title: '' } }],
  ['workflows/nodes/action-changelog-add.executor.js', 'ActionChangelogAddExecutor', { config: { changes: ['a'] }, invalid: { changes: [] } }],
  ['workflows/nodes/action-user-question.executor.js', 'ActionUserQuestionExecutor', { config: { question: 'q' }, invalid: { question: '' } }],
  ['workflows/nodes/control-condition.executor.js', 'ControlConditionExecutor', {
    config: { cases: [{ when: { path: 'a', op: 'eq', value: 1 }, branch: 'success' }] },
    invalid: { cases: [{ when: { path: '', op: 'eq', value: 1 }, branch: 'success' }] },
  }],
  ['workflows/nodes/control-delay.executor.js', 'ControlDelayExecutor', {
    config: { delayMs: 1000 },
    invalid: { delayMs: 1000, until: new Date().toISOString() },   // both set → refine fails
  }],
  ['workflows/nodes/trigger-project-event.executor.js', 'TriggerProjectEventExecutor', {
    config: { entity: 'todo', action: 'created' },
    invalid: { entity: 'nope', action: 'created' },
  }],
  ['workflows/nodes/trigger-customer-event.executor.js', 'TriggerCustomerEventExecutor', {
    config: { entity: 'todo', action: '*' },
    invalid: { entity: 'todo', action: 'nope' },
  }],
  ['workflows/nodes/agent-task.executor.js', 'AgentTaskExecutor', { config: { prompt: 'hi' }, invalid: { prompt: '' } }],
];

for (const [relPath, exportName, fixture] of allExecutors) {
  const Cls = loadCompiled(relPath)[exportName];
  const instance = Object.create(Cls.prototype);
  const meta = instance.metadata ?? Cls.prototype.metadata;
  check(`${exportName}.metadata.configSchema accepts valid config`, () => {
    const parsed = meta.configSchema.safeParse(fixture.config);
    if (!parsed.success) throw new Error(`expected valid but got: ${JSON.stringify(parsed.error.issues)}`);
  });
  if (fixture.invalid !== null) {
    check(`${exportName}.metadata.configSchema rejects invalid config`, () => {
      const parsed = meta.configSchema.safeParse(fixture.invalid);
      assert.equal(parsed.success, false);
    });
  }
}

// ---------- WorkflowEventListener.matches ----------
const listenerMod = loadCompiled('workflows/engine/workflow-event-listener.service.js');
const ListenerCls = listenerMod.WorkflowEventListener;
const matches = Object.create(ListenerCls.prototype).matches;

check('matches: exact entity/action', () => {
  assert.equal(matches.call({}, { entity: 'todo', action: 'created' }, { entity: 'todo', action: 'created' }), true);
});
check('matches: entity wildcard', () => {
  assert.equal(matches.call({}, { entity: '*', action: 'created' }, { entity: 'knowledge', action: 'created' }), true);
});
check('matches: action wildcard', () => {
  assert.equal(matches.call({}, { entity: 'todo', action: '*' }, { entity: 'todo', action: 'deleted' }), true);
});
check('matches: entity mismatch fails', () => {
  assert.equal(matches.call({}, { entity: 'todo', action: 'created' }, { entity: 'milestone', action: 'created' }), false);
});
check('matches: action mismatch fails', () => {
  assert.equal(matches.call({}, { entity: 'todo', action: 'updated' }, { entity: 'todo', action: 'deleted' }), false);
});

// ---------- toPublicMetadata exports ----------
check('toPublicMetadata serializes configJsonSchema', () => {
  const { toPublicMetadata } = nodeMetadata;
  const { z } = require(path.resolve(__dirname, '..', 'node_modules', 'zod'));
  const meta = {
    type: 'x',
    category: 'action',
    label: 'x',
    description: 'x',
    allowedScopes: [],
    configSchema: z.object({ a: z.string() }),
    outputs: {},
    branches: ['success'],
  };
  const pub = toPublicMetadata(meta);
  assert.equal(pub.type, 'x');
  assert.equal(typeof pub.configJsonSchema, 'object');
});

// ----------
if (failures > 0) {
  console.error(`\n${failures}/${total} checks failed`);
  process.exit(1);
}
console.log(`\nAll ${total} checks passed`);
```

- [ ] **Step 2: Register npm script**

In `backend/package.json` `scripts`, after `check:workflow-runner-units`, ADD:
```json
"check:workflow-nodes-units": "node scripts/workflow-nodes-units-check.cjs",
```

- [ ] **Step 3: Build then run**

```bash
cd backend && npm run build && npm run check:workflow-nodes-units
```

Expected: all checks pass. If any fail, investigate — most likely a metadata fixture mismatch or a schema issue in a Task 6 / 8 / 9 / 11 executor.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/workflow-nodes-units-check.cjs backend/package.json
git commit -m "test(workflows): pure-logic check script for node catalog (T-252)"
```

---

## Task 18: Engine integration check (scenarios A + B + opt-in C)

**Files:**
- Create: `backend/scripts/workflow-nodes-engine-check.cjs`
- Modify: `backend/package.json`

- [ ] **Step 1: Write the integration check**

```js
#!/usr/bin/env node
/*
 * T-252 integration check.
 * Scenario A: delay + condition + question (always runs)
 * Scenario B: event-trigger (always runs)
 * Scenario C: agent.task — opt-in via DEVGRIMOIRE_WORKFLOW_AGENT_E2E=true
 */
const baseUrl = (process.env.DEVGRIMOIRE_BASE_URL || 'http://localhost:3200').replace(/\/$/, '');
const apiKey = process.env.DEVGRIMOIRE_API_KEY;
if (!apiKey) { console.error('DEVGRIMOIRE_API_KEY required'); process.exit(2); }
const projectId = process.env.DEVGRIMOIRE_PROJECT_ID;
if (!projectId) { console.error('DEVGRIMOIRE_PROJECT_ID required'); process.exit(2); }

const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
function assert(c, m) { if (!c) { console.error(`✗ ${m}`); process.exit(1); } }
async function http(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(getFn, isDone, timeoutMs, intervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(intervalMs);
    const v = await getFn();
    if (isDone(v)) return v;
  }
  return null;
}

async function scenarioA() {
  console.log('--- Scenario A: delay + condition + question ---');
  let defId, todoId;
  try {
    const def = await http('POST', '/api/workflows', {
      scope: 'project', projectId, name: `T252-A-${Date.now()}`,
      trigger: { type: 'manual' },
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
        { id: 'todo', type: 'action.todo-create', position: { x: 0, y: 0 },
          config: { title: 'T252 scenario A todo' }, secretRefs: [] },
        { id: 'delay', type: 'control.delay', position: { x: 0, y: 0 },
          config: { delayMs: 2000 }, secretRefs: [] },
        { id: 'cond', type: 'control.condition', position: { x: 0, y: 0 },
          config: {
            cases: [{ when: { path: 'nodes.todo.todoId', op: 'exists' }, branch: 'success' }],
            default: 'failure',
          }, secretRefs: [] },
        { id: 'q', type: 'action.user-question', position: { x: 0, y: 0 },
          config: { question: 'continue?', options: ['yes', 'no'], branchMap: { yes: 'success', no: 'failure' } }, secretRefs: [] },
        { id: 'comment', type: 'action.todo-comment', position: { x: 0, y: 0 },
          config: { todoId: '{{nodes.todo.todoId}}', text: 'answer was {{nodes.q.answer}}' }, secretRefs: [] },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'todo' },
        { id: 'e2', source: 'todo', target: 'delay' },
        { id: 'e3', source: 'delay', target: 'cond' },
        { id: 'e4', source: 'cond', target: 'q', branch: 'success' },
        { id: 'e5', source: 'q', target: 'comment', branch: 'success' },
      ],
    });
    defId = def._id;
    await http('PUT', `/api/workflows/${defId}`, { status: 'active' });
    const run = await http('POST', '/api/workflows/runs', { definitionId: defId });
    const runId = run._id;

    const waiting = await poll(
      () => http('GET', `/api/workflows/runs/${runId}`),
      (r) => r.status === 'waiting_for_user',
      15_000,
    );
    assert(waiting, `scenario A: run never entered waiting_for_user (latest status seen above)`);
    console.log(`✓ run entered waiting_for_user after delay+condition`);

    // find the open question for the engine's question
    const questions = await http('GET', `/api/questions?direction=agent_to_user&status=open&limit=10`);
    const myQ = questions.find((q) => q.agentRunId === runId);
    assert(myQ, 'scenario A: no question found for the run');
    todoId = await http('GET', `/api/workflows/runs/${runId}/node-runs`)
      .then((nrs) => nrs.find((n) => n.nodeId === 'todo'))
      .then((nr) => nr?.outputSnapshot?.todoId);
    assert(todoId, 'scenario A: todo node-run did not produce todoId');

    await http('PUT', `/api/questions/${myQ._id}`, { answer: 'yes' });
    const done = await poll(
      () => http('GET', `/api/workflows/runs/${runId}`),
      (r) => ['succeeded', 'failed', 'cancelled'].includes(r.status),
      10_000,
    );
    assert(done && done.status === 'succeeded', `scenario A: run did not succeed (${done?.status})`);
    console.log('✓ scenario A succeeded');

    const todo = await http('GET', `/api/todos/${todoId}`);
    const lastComment = (todo.comments ?? [])[todo.comments.length - 1];
    assert(lastComment?.text?.includes('answer was yes'), 'scenario A: comment missing expected text');
    console.log('✓ scenario A comment present');
  } finally {
    if (todoId) await http('DELETE', `/api/todos/${todoId}`).catch(() => {});
    if (defId) await http('DELETE', `/api/workflows/${defId}`).catch(() => {});
  }
}

async function scenarioB() {
  console.log('--- Scenario B: event-trigger ---');
  let defId, testTodoId;
  try {
    const def = await http('POST', '/api/workflows', {
      scope: 'project', projectId, name: `T252-B-${Date.now()}`,
      trigger: { type: 'manual' },
      nodes: [
        { id: 't', type: 'trigger.project_event', position: { x: 0, y: 0 },
          config: { entity: 'todo', action: 'created' }, secretRefs: [] },
        { id: 'log', type: 'action.log', position: { x: 0, y: 0 },
          config: { message: 'caught {{input.event.entityId}}' }, secretRefs: [] },
      ],
      edges: [{ id: 'e1', source: 't', target: 'log' }],
    });
    defId = def._id;
    await http('PUT', `/api/workflows/${defId}`, { status: 'active' });

    const beforeRuns = await http('GET', `/api/workflows/runs/list?definitionId=${defId}`);
    const beforeCount = Array.isArray(beforeRuns) ? beforeRuns.length : 0;

    // Trigger a real PROJECT_CHANGED event
    const testTodo = await http('POST', '/api/todos', {
      projectId, title: 'T252 scenario B test todo',
    });
    testTodoId = testTodo._id;

    // Wait for the event listener to fire and the run to complete
    const afterRuns = await poll(
      () => http('GET', `/api/workflows/runs/list?definitionId=${defId}`),
      (rs) => Array.isArray(rs) && rs.length > beforeCount && rs.some((r) => r.status === 'succeeded'),
      10_000,
    );
    assert(afterRuns, 'scenario B: no new succeeded run after todo create');
    const myRun = afterRuns.find((r) => r.status === 'succeeded');
    assert(myRun, 'scenario B: no succeeded run found');
    console.log(`✓ event-triggered run ${myRun._id} succeeded`);

    const nodeRuns = await http('GET', `/api/workflows/runs/${myRun._id}/node-runs`);
    const logNr = nodeRuns.find((n) => n.nodeId === 'log');
    assert(logNr, 'scenario B: log node-run missing');
    const expectedSubstring = testTodoId;
    const logLine = logNr.logs?.find?.((l) => String(l.msg ?? '').includes(expectedSubstring));
    assert(logLine, `scenario B: log node-run did not capture entityId ${expectedSubstring}`);
    console.log('✓ scenario B captured event payload via template');
  } finally {
    if (testTodoId) await http('DELETE', `/api/todos/${testTodoId}`).catch(() => {});
    if (defId) await http('DELETE', `/api/workflows/${defId}`).catch(() => {});
  }
}

async function scenarioC() {
  if (process.env.DEVGRIMOIRE_WORKFLOW_AGENT_E2E !== 'true') {
    console.log('--- Scenario C: agent.task SKIPPED (set DEVGRIMOIRE_WORKFLOW_AGENT_E2E=true to run) ---');
    return;
  }
  console.log('--- Scenario C: agent.task ---');
  const cfg = await http('GET', `/api/workflows/agent-config`);
  assert(cfg && cfg.hasApiKey !== undefined, 'scenario C: agent-config not set up');
  let defId;
  try {
    const def = await http('POST', '/api/workflows', {
      scope: 'project', projectId, name: `T252-C-${Date.now()}`,
      trigger: { type: 'manual' },
      nodes: [
        { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
        { id: 'agent', type: 'agent.task', position: { x: 0, y: 0 },
          config: { prompt: 'Answer with exactly the word PONG and nothing else.' }, secretRefs: [] },
      ],
      edges: [{ id: 'e1', source: 't', target: 'agent' }],
    });
    defId = def._id;
    await http('PUT', `/api/workflows/${defId}`, { status: 'active' });
    const run = await http('POST', '/api/workflows/runs', { definitionId: defId });
    const done = await poll(
      () => http('GET', `/api/workflows/runs/${run._id}`),
      (r) => ['succeeded', 'failed', 'cancelled'].includes(r.status),
      120_000,
    );
    assert(done && done.status === 'succeeded', `scenario C: agent run did not succeed (${done?.status} ${JSON.stringify(done?.error)})`);
    const nodeRuns = await http('GET', `/api/workflows/runs/${run._id}/node-runs`);
    const agentNr = nodeRuns.find((n) => n.nodeId === 'agent');
    assert(agentNr?.outputSnapshot?.response, 'scenario C: agent.task produced no response');
    console.log(`✓ scenario C agent response: ${String(agentNr.outputSnapshot.response).slice(0, 80)}...`);
  } finally {
    if (defId) await http('DELETE', `/api/workflows/${defId}`).catch(() => {});
  }
}

(async () => {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  console.log('\nAll T-252 integration scenarios passed.');
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Register npm script**

In `backend/package.json`, add to `scripts`:
```json
"check:workflow-nodes-engine": "node scripts/workflow-nodes-engine-check.cjs"
```

- [ ] **Step 3: Rebuild backend**

```bash
docker compose up -d --build backend
```

Wait for healthy (poll `curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer <key>' http://localhost:3200/api/projects` until 200).

- [ ] **Step 4: Run scenarios A + B**

```bash
cd backend && DEVGRIMOIRE_API_KEY=<key> DEVGRIMOIRE_PROJECT_ID=<project-id> npm run check:workflow-nodes-engine
```

Expected: scenarios A + B both pass; C printed as SKIPPED.

If a scenario fails, do NOT loosen assertions. Read the run's error / node-runs to understand which executor or engine path broke. Fix in the relevant file, rebuild, re-run.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/workflow-nodes-engine-check.cjs backend/package.json
git commit -m "test(workflows): integration check for delay/condition/question + event-trigger (T-252)"
```

---

## Task 19: Settings UI section for workflow-agent (minimal)

**Files:** Add a new section to the existing Settings page in `frontend/src/`. The acceptance criterion is "user can configure the workflow-agent endpoint" — a minimal form suffices.

- [ ] **Step 1: Locate the Settings page**

```bash
grep -rln "chat.*endpoint\|chat_llm_endpoints\|Chat LLM" frontend/src/pages frontend/src/components 2>/dev/null | head -5
```

Open the file that renders the Chat-LLM-Endpoints section. Identify the component pattern (likely a form with provider/url/model/apiKey inputs).

- [ ] **Step 2: Add a sibling section**

Below the Chat-LLM section, add a similar form labeled "Workflow Agent LLM" that posts to `PUT /api/workflows/agent-config` and reads from `GET /api/workflows/agent-config`. Fields:
- provider (dropdown: lmstudio, openai-compatible, openai, anthropic)
- url (text)
- model (text)
- apiKey (password input — empty submission means "keep existing", clear button submits empty string)
- toolsEnabled (checkbox)
- maxToolIterations (number input 1..20)

Reuse styling primitives from the existing section. Aim for ~80 LOC TSX max. If the existing section uses a typed API client (`apiClient.get/put`), use the same pattern with these two paths.

If the codebase uses i18next (per CLAUDE.md), add a `workflowAgent.*` namespace with German + English strings; if not, hardcode German for now.

- [ ] **Step 3: Smoke test**

```bash
docker compose up -d --build frontend
# Open http://localhost in browser, navigate to Settings, see new section
```

Manual: enter a config, save, refresh, verify hasApiKey-toggle reflects state, then GET /api/workflows/agent-config returns the values.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/<the file you modified>
git commit -m "feat(workflows): settings UI section for workflow-agent endpoint (T-252)"
```

---

## Task 20: Backend lint + final verification

- [ ] **Step 1: Run all check scripts**

```bash
cd backend
npm run build
npm run check:workflow-runner-units
DEVGRIMOIRE_API_KEY=<key> DEVGRIMOIRE_PROJECT_ID=<project-id> npm run check:workflow-engine    # T-250 regression
npm run check:workflow-nodes-units
DEVGRIMOIRE_API_KEY=<key> DEVGRIMOIRE_PROJECT_ID=<project-id> npm run check:workflow-nodes-engine
npm run check:mcp-registry
```

All must be green. T-250's check stays green to confirm no regression.

- [ ] **Step 2: Manual catalog smoke**

```bash
curl -s -H "Authorization: Bearer <key>" http://localhost:3200/api/workflows/node-types | jq 'length'
```

Expected: ≥ 16 (5 T-250 + 11 T-252).

```bash
curl -s -H "Authorization: Bearer <key>" http://localhost:3200/api/workflows/node-types | jq '[.[] | .type] | sort'
```

Verify all expected types are present.

- [ ] **Step 3: Move T-252 → review via REST**

```bash
curl -s -X PUT http://localhost:3200/api/todos/<T-252-id> -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"status":"review"}'
```

(T-252 ID: query via `mcp__devgrimoire__todo_list` or look up the displayNumber.)

- [ ] **Step 4: Post review comment + transition to done**

Compile a code-review-style comment listing: 11 new executors, NodeMetadata system, endpoint, agent service, delay-scheduler, event-listener, what was tested, any known follow-ups. Post via:

```bash
curl -s -X POST http://localhost:3200/api/todos/<id>/comments \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"text":"<the comment text>","author":"claude"}'
```

After honest code review pass (re-read each new executor, look for service-signature drifts, missing nullguards, scope-creep), if no real issues remain:

```bash
curl -s -X PUT http://localhost:3200/api/todos/<T-252-id> -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"status":"done"}'
```

---

## Task 21: DevGrimoire docs (knowledge, manual, changelog)

Mirror T-250's documentation post-step.

- [ ] **Step 1: Knowledge entry**

POST to `/api/knowledge` with:
- topic: "Workflow Node Catalog (T-252)"
- scope: project, projectId, category: "Architecture"
- tags: ["workflows", "nodes", "agent", "M-31"]
- content: comprehensive description of NodeMetadata system, the 11 new executors, agent-task subsystem, delay-scheduler, event-listener, config-validation flow, environment variables (`WORKFLOW_AGENT_TOOL_ALLOWLIST`). Reference `docs/workflow-nodes.md`.

- [ ] **Step 2: Manual page**

POST to `/api/manuals`:
- title: "Workflow-Nodes — Katalog & Konfiguration (T-252)"
- projectId, category: "Workflows", sortOrder: 20
- content: operator-facing guide listing each new node type with config examples, branch semantics, scope restrictions, agent-task setup walkthrough (settings UI + endpoint config), example workflows (todo-update-after-question, event-driven notify, condition-branched comments).

- [ ] **Step 3: Changelog**

POST to `/api/changelog`:
- projectId, version: "T-252", component: "Backend"
- summary: "Workflow-Module: 11 native Nodes, NodeMetadata-Endpoint, Agent-Task mit Tool-Calling, persistente Delays, Event-Trigger"
- changes: bullet list of all task outputs

- [ ] **Step 4: Push**

```bash
git push origin main
```

---

## Self-Review Summary

**Spec coverage** (each section → tasks):

| Spec requirement | Task(s) |
|---|---|
| NodeMetadata + JSON-Schema export | 3, 4 (retrofit T-250) |
| `GET /api/workflows/node-types` | 13, 16 (wiring) |
| MCP `workflow_node_types_list` | 13, 16 |
| `WAITING_FOR_TIMER` status + waitingFor union | 2, 10 (engine path) |
| Mini CRUD executors (todo-update, todo-comment, link-milestone, knowledge, manual, changelog) | 6 |
| `action.user-question` + branchMap engine path | 7 |
| `control.condition` + condition-ops | 8 |
| `control.delay` + `WorkflowDelayScheduler` + `resumeDelayedNode` | 9, 10 |
| Event-triggers + `WorkflowEventListener` + `context.input` propagation | 11 |
| Activation-time zod schema validation | 12 |
| Workflow-agent settings + DTOs | 14 |
| `WorkflowAgentService.run` (OpenAI + Anthropic + tool loop) + `agent.task` executor | 15 |
| Agent-config controller + module wiring | 16 |
| Pure-logic check | 17 |
| Integration check (A delay/cond/question, B event, C agent opt-in) | 18 |
| Settings UI section for workflow-agent | 19 |
| Lint + final verification + T-252 → review → done | 20 |
| DevGrimoire docs (knowledge / manual / changelog) | 21 |

**Type consistency** — `NodeMetadata.configSchema` is a zod `ZodSchema` throughout. `NodeResult.waitingFor` is union of `{type:'question'}` and `{type:'delay'}` from Task 9 onwards. `WorkflowRunStatus.WAITING_FOR_TIMER` is added in Task 2 and used in Task 10. The agent service uses `ChatToolsService.execute(name, args, ctx, allowlist)` with `ctx.projectId: string | null` — matches the existing service signature inspected in Task 15.

**Open follow-ups correctly out of scope** (per spec): T-251 Canvas-UI consuming `/node-types`, T-256 extending agent-task tool policy, HTTP-Request / Workspace / Git nodes.
