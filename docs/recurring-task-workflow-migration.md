# Recurring Tasks ↔ Workflows: Migration and Coexistence

DevGrimoire already has `RecurringTask` as a lightweight scheduler for project, customer, and system-wide recurring work. The upcoming Workflow module should not replace it abruptly. The safe path is coexistence first, optional migration later.

## Current RecurringTask behavior

Source files:

- `backend/src/recurring-tasks/schemas/recurring-task.schema.ts`
- `backend/src/recurring-tasks/recurring-tasks.service.ts`
- `backend/src/recurring-tasks/recurring-tasks.controller.ts`
- UI pages under `frontend/src/pages/RecurringTask*` and `frontend/src/components/RecurringTaskList.tsx`

Current model summary:

- A recurring task is scoped by exactly one of:
  - `projectId`
  - `customerId`
  - neither, meaning system-wide.
- Scheduling uses `frequency`, optional `dayOfWeek`, `dayOfMonth`, `month`, `hour`, `active`, `nextRun`, `lastRun`, and `maxCatchUp`.
- Execution is intentionally simple:
  - Project-scoped task creates a project Todo.
  - Customer-scoped task creates a customer Todo/quest.
  - System-wide task creates a notification.
- Created todos are tracked in `createdTodoIds`.
- REST API is `/api/recurring-tasks` with create/list/get/update/delete/trigger.
- MCP/chat tooling already exposes recurring task list/get/create/update operations.

## Coexistence strategy

### Phase 1: Keep RecurringTask as the simple scheduler

Recurring Tasks remain the recommended feature when the user wants exactly one scheduled action:

- create a Todo repeatedly,
- create a customer quest repeatedly,
- create a system notification repeatedly,
- manually trigger that single recurring action.

Workflows are introduced for multi-step, branching, inspectable, or agent-assisted automation.

UI copy should make this distinction explicit:

- **Recurring Task:** “Simple schedule → one result.”
- **Workflow:** “Repeatable process → multiple steps, branches, history, and recovery.”

### Phase 2: Cross-link without data migration

Before any conversion feature exists, add soft links between both concepts:

- Workflow docs and empty-state CTAs can suggest recurring tasks for one-step schedules.
- RecurringTask detail pages can suggest workflows when the description implies multiple steps, agent prompts, approvals, or conditional logic.
- Workflow definitions may reference a source recurring task only as metadata, not as ownership.

Suggested optional workflow field:

```ts
legacySource?: {
  type: 'recurring-task';
  id: string;
  migratedAt?: Date;
}
```

This keeps migration reversible because the legacy task is not deleted or overwritten.

### Phase 3: Optional “Convert to Workflow” wizard

Conversion should be explicit and user-triggered. The wizard creates a new WorkflowDefinition and leaves the RecurringTask paused or unchanged based on user choice.

Recommended choices after conversion:

1. **Keep RecurringTask active** — useful for previewing the generated workflow without behavior change.
2. **Pause RecurringTask** — preferred when activating the generated workflow immediately.
3. **Archive later** — only after workflow runs have been verified.

Do not auto-delete recurring tasks during conversion.

## Mapping: RecurringTask → Workflow

A migrated recurring task becomes a WorkflowDefinition with a schedule trigger plus one action node.

### Common fields

| RecurringTask field | WorkflowDefinition / node mapping |
| --- | --- |
| `projectId` | `scope: 'project'`, `projectId` |
| `customerId` | `scope: 'customer'`, `customerId` |
| neither | `scope: 'system'` |
| `title` | Workflow `name`; action node label/title |
| `description` | Workflow `description`; Todo/notification description |
| `tags` | Workflow `tags`; Todo tags for create-todo node |
| `active` | `status: active` if converting and enabling, otherwise `paused` |
| `frequency`, `dayOfWeek`, `dayOfMonth`, `month`, `hour` | Schedule trigger config |
| `priority`, `milestoneId`, `repoLabel` | Todo create node config |
| `createdTodoIds` | Not copied into definition; optionally referenced in migration audit metadata |
| `lastRun`, `nextRun` | Runtime scheduler state; initialize Workflow scheduler from trigger config, not copied blindly |
| `maxCatchUp` | Workflow trigger catch-up policy if supported; otherwise record in migration notes |

### Project-scoped task

```json
{
  "scope": "project",
  "projectId": "...",
  "name": "<RecurringTask.title>",
  "trigger": {
    "type": "schedule",
    "frequency": "weekly",
    "hour": 9,
    "dayOfWeek": 1
  },
  "nodes": [
    {
      "id": "create_todo",
      "type": "todo.create",
      "label": "Create project todo",
      "config": {
        "title": "<RecurringTask.title>",
        "description": "<RecurringTask.description>",
        "priority": "medium",
        "tags": [],
        "milestoneId": null,
        "repoLabel": null
      }
    }
  ],
  "edges": []
}
```

### Customer-scoped task

Use the same schedule trigger, but create a customer-scoped Todo:

```json
{
  "scope": "customer",
  "customerId": "...",
  "nodes": [
    {
      "id": "create_customer_todo",
      "type": "todo.create",
      "config": {
        "customerId": "...",
        "title": "<RecurringTask.title>",
        "description": "<RecurringTask.description>",
        "priority": "medium",
        "tags": []
      }
    }
  ]
}
```

### System-wide task

Map to a notification node:

```json
{
  "scope": "system",
  "nodes": [
    {
      "id": "create_notification",
      "type": "notification.create",
      "config": {
        "title": "<RecurringTask.title>",
        "message": "<RecurringTask.description || title>",
        "source": "recurring"
      }
    }
  ]
}
```

## API and MCP compatibility

Keep existing endpoints and tools stable:

- `GET /api/recurring-tasks`
- `POST /api/recurring-tasks`
- `GET /api/recurring-tasks/:id`
- `PUT /api/recurring-tasks/:id`
- `DELETE /api/recurring-tasks/:id`
- `POST /api/recurring-tasks/:id/trigger`
- MCP/chat tools: `recurring_task_list`, `recurring_task_get`, `recurring_task_create`, `recurring_task_update`

Add workflow APIs separately. If a conversion endpoint is introduced, it should be additive:

```http
POST /api/recurring-tasks/:id/convert-to-workflow
```

Suggested request:

```json
{
  "activateWorkflow": false,
  "pauseRecurringTask": false
}
```

Suggested response:

```json
{
  "workflowId": "...",
  "recurringTaskId": "...",
  "recurringTaskPaused": false
}
```

MCP tool equivalent:

- `recurring_task_convert_to_workflow`

The tool must default to preview or inactive workflow creation unless the caller explicitly asks to activate it.

## UI strategy

### Short term

Keep existing RecurringTask pages and ProjectDetail/CustomerDetail tabs. Add explanatory copy and links:

- From RecurringTask detail: “Need multiple steps or an agent? Convert to workflow.”
- From Workflow create: “For a single repeated Todo, use Recurring Tasks.”

### Medium term

Embed Recurring Tasks into the workflow mental model without moving data:

- Project tabs show both “Recurring Tasks” and “Workflows”.
- Workflow templates can include “weekly project triage” while Recurring Tasks remain the fast path.
- RecurringTask list rows can display a `Converted to workflow` badge if `legacySource` metadata exists on a linked workflow.

### Long term

After Workflow scheduling is battle-tested, recurring tasks may become a simplified UI over one-node workflows for new records. Existing records should still be readable and executable through compatibility code.

## Backward-compatibility rules

- Never delete or mutate existing RecurringTask records during read-only migration previews.
- Existing REST and MCP behavior must remain stable for agents and older clients.
- The scheduler must not double-run after conversion; the user chooses whether to pause the legacy task or keep the workflow inactive.
- `createdTodoIds` history remains on the legacy record; WorkflowRun history starts fresh.
- Replication/export code must keep supporting `recurring-task` entities until all deployed peers understand workflows.
- Customer transfer/export must continue including recurring tasks independently from workflows.

## Implementation checklist

1. Add WorkflowDefinition and WorkflowRun models without changing RecurringTask execution.
2. Add schedule trigger support in Workflow runner.
3. Add `todo.create` and `notification.create` nodes matching current RecurringTask behavior.
4. Add read-only conversion preview service.
5. Add explicit conversion endpoint/tool that creates an inactive workflow by default.
6. Add UI wizard with activation/pause choice.
7. Add tests covering project, customer, and system-wide conversion.
8. Only after production validation, consider a compatibility layer that renders simple one-node workflows as recurring tasks.

## Open decisions

- Should converted workflows copy `maxCatchUp`, or should Workflow triggers use their own default catch-up policy?
- Should a converted workflow receive the same `nextRun` timestamp for continuity, or recompute from the schedule for safety?
- Should RecurringTask `trigger` create a Todo immediately forever, or eventually delegate to linked active workflow when a legacy link exists?

Recommendation for MVP: recompute scheduler state, keep legacy trigger behavior unchanged, and make conversion create an inactive workflow by default.
