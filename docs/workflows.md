# Visual Workflows

DevGrimoire workflows are planned as project/customer-aware, visual automations for recurring work, agent-assisted checklists, and long-running operations. They complement existing Todos, Recurring Tasks, and Chat sessions instead of replacing them in the MVP.

For the detailed coexistence and migration plan for existing Recurring Tasks, see [`recurring-task-workflow-migration.md`](./recurring-task-workflow-migration.md). For user-facing examples, templates, and agent guidance, see [`workflow-examples.md`](./workflow-examples.md). For the template catalog and guided creation wizard, see [`workflow-template-wizard.md`](./workflow-template-wizard.md).

## When to use what

- **Todo**: a human-readable unit of work with status, comments, and review flow.
- **Recurring Task**: a simple schedule that creates/reminds/runs one known action.
- **Chat**: an interactive agent workspace for ad-hoc reasoning and user questions.
- **Workflow**: a versioned graph of triggers, nodes, branches, and run history where multiple steps must be repeatable, inspectable, and resumable.

## Domain model

### WorkflowDefinition

A workflow definition is the mutable design-time record.

Recommended schema fields:

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | ObjectId | Primary key |
| `scope` | `system \| project \| customer` | Controls visibility and execution boundaries |
| `projectId` | ObjectId? | Required for `project` scope, absent otherwise |
| `customerId` | ObjectId? | Required for `customer` scope, absent otherwise |
| `name` | string | User-facing name |
| `description` | string? | Markdown-friendly description |
| `status` | `draft \| active \| paused \| archived` | Only `active` definitions are scheduled automatically |
| `version` | number | Incremented on every publish/change that affects execution semantics |
| `tags` | string[] | Search/filter metadata |
| `trigger` | object | Schedule/webhook/manual/todo/chat trigger config |
| `nodes` | WorkflowNode[] | Embedded design-time graph nodes |
| `edges` | WorkflowEdge[] | Embedded design-time graph edges |
| `ui` | object? | Canvas-level UI metadata such as viewport |
| `createdByUserId` | ObjectId? | Audit ownership |
| `updatedByUserId` | ObjectId? | Last editor |
| `createdAt` / `updatedAt` | Date | Timestamps |

DTOs:

- `CreateWorkflowDefinitionDto`: `scope`, owner id (`projectId`/`customerId`), `name`, optional `description`, `tags`, `trigger`, `nodes`, `edges`, `ui`.
- `UpdateWorkflowDefinitionDto`: editable metadata/graph fields; publishing increments `version`.
- `WorkflowDefinitionListQueryDto`: `scope`, `projectId`, `customerId`, `status`, `tag`, `includeArchived`, `limit`, `offset`.

### WorkflowNode

Nodes are embedded in a definition and copied into run snapshots.

Recommended fields:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable graph-local id, e.g. `node_abc123` |
| `type` | string | DevGrimoire-native node type, e.g. `todo.create`, `chat.prompt`, `ask_user`, `condition` |
| `label` | string? | UI label override |
| `position` | `{ x: number; y: number }` | React Flow compatible |
| `config` | object | Node-specific settings; never store plaintext secrets |
| `secretRefs` | string[] | References to DevGrimoire Secret ids/keys, resolved at runtime with scope checks |
| `inputs` / `outputs` | object? | Optional port metadata for validation/UI |
| `ui` | object? | Color/icon/collapsed notes, non-runtime-critical |

Config must be JSON-serializable and deterministic. Runtime-only values belong in `WorkflowRun`/`WorkflowNodeRun`, not in definitions.

### WorkflowEdge

Edges define execution flow and branch semantics.

Recommended fields:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable graph-local id |
| `source` | string | Source node id |
| `target` | string | Target node id |
| `sourcePort` / `targetPort` | string? | Optional named ports |
| `branch` | `success \| failure \| always \| custom`? | Common branch category |
| `condition` | object? | Safe expression/condition descriptor, not arbitrary code |
| `label` | string? | UI label |
| `ui` | object? | Non-runtime visual metadata |

Conditions should use a constrained expression format such as `{ left, operator, right }` or JSONLogic-like descriptors. Do not execute user-provided JavaScript.

### WorkflowRun

A run is an immutable execution instance pinned to one definition version.

Recommended fields:

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | ObjectId | Primary key |
| `definitionId` | ObjectId | Source definition |
| `definitionVersion` | number | Version used for this run |
| `definitionSnapshot` | object | Frozen copy of trigger/nodes/edges/name/scope at start |
| `scope` / owner ids | same as definition | Denormalized for filtering and permission checks |
| `trigger` | object | Actual trigger event: manual, schedule, webhook, todo, chat |
| `status` | `queued \| running \| waiting_for_user \| succeeded \| failed \| cancelled` | Overall run lifecycle |
| `currentNodeIds` | string[] | Active/waiting nodes |
| `startedAt` / `finishedAt` | Date? | Duration source |
| `createdByUserId` | ObjectId? | Manual/user-origin trigger |
| `error` | object? | Top-level failure summary |
| `createdAt` / `updatedAt` | Date | Timestamps |

DTOs:

- `StartWorkflowRunDto`: `definitionId`, optional trigger payload/input, optional idempotency key.
- `WorkflowRunListQueryDto`: `definitionId`, owner scope, `status`, `since`, `until`, `limit`, `offset`.
- `CancelWorkflowRunDto`: optional reason.

### WorkflowNodeRun

Node runs are append-only execution records for observability and replay.

Recommended fields:

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | ObjectId | Primary key |
| `runId` | ObjectId | Parent run |
| `definitionId` | ObjectId | Denormalized for queries |
| `definitionVersion` | number | Pinned version |
| `nodeId` | string | Graph-local node id from snapshot |
| `nodeType` | string | Denormalized for filtering |
| `status` | `queued \| running \| waiting \| succeeded \| failed \| skipped \| retrying` | Node lifecycle |
| `attempt` | number | Starts at 1; increment on retry |
| `inputSnapshot` | object? | Sanitized runtime input |
| `outputSnapshot` | object? | Sanitized runtime output |
| `logs` | array | Structured log lines, no secrets |
| `error` | object? | Sanitized error code/message/details |
| `startedAt` / `finishedAt` | Date? | Duration source |
| `durationMs` | number? | Cached duration |

Store large artifacts as attachments and reference them by id rather than embedding huge payloads.

## Scope and permission rules

- `system` workflows are admin-only by default and must not implicitly access project/customer secrets.
- `project` workflows require `projectId`; every run and node action is constrained to that project unless a node explicitly requests a narrower customer/project link and passes permission checks.
- `customer` workflows require `customerId`; project access is limited to projects linked to that customer and visible to the actor/API key.
- A workflow may reference secrets only through `secretRefs`. Runtime resolution must check the workflow scope, the actor/API key permissions, and the target environment/customer/project.
- API keys need explicit workflow tool permissions. Write/run tools must be separated from read/list tools.
- RAG/search nodes must include scope filters to avoid cross-customer/project leakage.

## Versioning strategy

- Editing a draft definition updates the same `version` until the first publish.
- Publishing or changing an active workflow's runtime graph increments `version`.
- Every `WorkflowRun` stores `definitionVersion` and a `definitionSnapshot`; running or historical runs never read mutable graph data from the latest definition.
- UI should show when a run used an older version and offer replay against the same snapshot or latest version explicitly.
- Non-runtime UI-only changes can update `ui` without incrementing `version` if they cannot affect execution.

## Suggested indexes

Definitions:

```ts
{ scope: 1, projectId: 1, customerId: 1, status: 1, updatedAt: -1 }
{ tags: 1 }
{ name: 'text', description: 'text' }
```

Runs:

```ts
{ definitionId: 1, createdAt: -1 }
{ scope: 1, projectId: 1, customerId: 1, status: 1, createdAt: -1 }
{ status: 1, updatedAt: 1 } // runner pickup for queued/waiting work
```

Node runs:

```ts
{ runId: 1, nodeId: 1, attempt: 1 }
{ definitionId: 1, nodeType: 1, createdAt: -1 }
{ status: 1, updatedAt: 1 }
```

## Backward compatibility with RecurringTask

The MVP should leave existing RecurringTask behavior untouched. A later adapter can expose a RecurringTask as a simple one-trigger/one-action workflow, but no migration should be required for existing schedules. During coexistence:

- RecurringTask remains the simple path for single scheduled actions.
- Workflow handles multi-step branching, user waits, tool calls, and replay.
- Cross-links may be added (`recurringTaskId` on trigger metadata or `workflowDefinitionId` on future migrated tasks), but reads/writes must not break old records.

## MVP boundaries

- No arbitrary code execution in workflow conditions or node configs.
- No plaintext secrets in definitions, runs, logs, or snapshots.
- No automatic destructive node execution without explicit node type allowlist and audit trail.
- Keep UI metadata separate from execution-critical graph fields.
- Treat documentation and examples as contract before adding MCP write tools.
