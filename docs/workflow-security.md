# Workflow Security, Permissions, and Secrets

Visual workflows can create todos, call agents, wait for users, touch secrets, and eventually run integrations. The MVP must therefore be deny-by-default: a workflow can only do what its scope, actor, API key, node type, and approval state explicitly allow.

## Security goals

- Prevent cross-project/customer data leaks.
- Keep plaintext secrets out of definitions, runs, logs, notifications, RAG, and exports.
- Make risky automation visible and reviewable before activation.
- Preserve an audit trail for who changed, activated, or executed what.
- Bound runtime, retries, loops, model/tool costs, and external side effects.

## Roles and permissions by scope

Workflow permissions are evaluated against both the user/API key and the workflow scope.

| Action | System scope | Project scope | Customer scope |
| --- | --- | --- | --- |
| View definition/run | Admin by default | Project member/admin | Customer/project member/admin |
| Create draft | Admin | Project editor/admin | Customer editor/admin |
| Edit draft | Admin or owner | Project editor/admin | Customer editor/admin |
| Publish/activate | Admin only in MVP | Project admin | Customer admin |
| Manual run | Admin | Project editor/admin if workflow is active | Customer editor/admin if workflow is active |
| Cancel run | Admin | Project editor/admin | Customer editor/admin |
| View secret-backed config | Never plaintext; only `hasSecretRef` | Never plaintext | Never plaintext |

MVP recommendation:

- `system` workflows are admin-only.
- `project` workflows require `projectId`; every node execution receives that `projectId` as an immutable scope filter.
- `customer` workflows require `customerId`; project access is limited to linked projects that the actor/API key may access.
- API keys need explicit workflow tool permissions. Read/list, write/edit, activate, and run permissions should be separate.

## Node risk classes

Every node type should declare a risk class. Unknown node types are blocked.

| Risk | Examples | MVP behavior |
| --- | --- | --- |
| `safe-read` | list todo, read knowledge, RAG search with scope filter | Allowed if actor can read scope |
| `safe-write` | create todo, add todo comment, write workflow log | Allowed for editors; audited |
| `human-wait` | ask_user / approval wait | Allowed; must record target user and timeout |
| `agent-write` | agent prompt that can call write tools | Requires workflow activation approval and tool allowlist |
| `secret-read` | resolve SecretRef for integration | Requires admin/project admin approval; never persisted plaintext |
| `external-call` | HTTP/webhook/email | Blocked in MVP unless explicitly allowlisted later |
| `workspace-git` | workspace exec, git/release action | Blocked in MVP unless explicitly allowlisted later |
| `destructive` | delete/archive/bulk mutation | Blocked by default; requires future explicit confirmation policy |

A workflow definition is publishable only when all nodes are known, valid for the workflow scope, and allowed by the activation actor.

## Approval and activation model

Drafts can be edited freely by authorized editors, but only active workflows run automatically.

Activation checklist:

1. Validate graph structure: one or more triggers, no dangling edges, no invalid ports.
2. Validate scope: every node supports the definition scope.
3. Validate node risk: block unknown, destructive, external, and workspace nodes by default.
4. Validate SecretRefs: references exist, belong to the same scope or an allowed linked scope, and are readable by the activation actor.
5. Validate budgets: max runtime, max node count, max iterations, retry limits, and schedule frequency.
6. Record approval: actor, timestamp, version, risk summary, and allowed node types/tools.

Changing runtime-affecting graph fields after activation creates a new version and returns to `draft` or `paused` until reviewed again. Pure UI metadata changes may skip reapproval if they cannot affect execution.

## Secret handling

Definitions and runs must store references, never plaintext secrets.

Recommended patterns:

- Node config uses `secretRefs`, e.g. `{ kind: "secret", secretId: "...", field: "apiKey" }`.
- Runtime resolves secrets only inside the node executor, after scope and permission checks.
- Plaintext secret values are not written to:
  - `WorkflowDefinition`
  - `WorkflowRun`
  - `WorkflowNodeRun`
  - logs, notifications, activity events
  - RAG/knowledge/changelog/manual content
  - exported workflow bundles, unless a future explicit encrypted export feature exists
- Logs use stable masks such as `***`, `sk_...abcd`, or `{secret:<id>}`.
- Error messages from external clients must pass through redaction before persistence.

Redaction should cover at least:

- Authorization/Bearer headers
- API keys/tokens/passwords
- URLs with credentials or `apiKey`, `token`, `password`, `secret` query parameters
- known Secret values resolved during the run

## Audit events

Generate audit/activity events for:

- workflow definition created/updated/published/paused/archived
- activation approval accepted/rejected
- run queued/started/succeeded/failed/cancelled
- node execution started/succeeded/failed/retried/skipped
- secret reference resolved (log only ref id/scope, not value)
- external or future workspace/git action attempted
- permission denial and validation failure

Minimum audit payload:

```json
{
  "workflowDefinitionId": "...",
  "workflowVersion": 3,
  "workflowRunId": "...",
  "nodeId": "optional",
  "actorUserId": "optional",
  "apiKeyId": "optional",
  "scope": "project",
  "projectId": "...",
  "customerId": null,
  "action": "workflow.run.started",
  "risk": "safe-write",
  "result": "success",
  "timestamp": "2026-05-09T01:00:00.000Z"
}
```

## Runtime limits

Set conservative defaults and allow project/admin overrides later.

| Limit | MVP default |
| --- | --- |
| Max nodes per definition | 100 |
| Max active runs per workflow | 1 for scheduled workflows unless configured otherwise |
| Max total run duration | 30 minutes |
| Max node duration | 2 minutes for normal nodes; user-wait nodes use explicit timeout |
| Max retries per node | 2 |
| Max loop/branch traversals | 100 node executions per run |
| Minimum schedule interval | 5 minutes |
| Max agent/tool iterations | Use Chat/Agent settings cap; default <= 5 |
| Max persisted log line length | 4 KB after redaction |

The runner must fail closed: if limits are missing, invalid, or exceeded, mark the node/run failed with a sanitized error.

## Loop and cost protection

- Require explicit loop-capable node/edge configuration; implicit cycles should fail validation.
- Track node execution count per run and stop at the configured cap.
- For agent nodes, pass a strict tool allowlist and scope filters.
- Store estimated cost/usage metrics when available, but never prompts or secrets in metric logs.
- Add idempotency keys for trigger events to avoid duplicate runs after retries or webhook redelivery.

## MVP deny-by-default policy

Allowed in MVP:

- manual/schedule/project/customer triggers
- todo create/update/comment with scope checks
- knowledge/manual/changelog append/create with scope checks
- user question/wait nodes
- notifications/log nodes
- scoped RAG/search/read nodes
- condition/switch/delay nodes using constrained config

Blocked until separately designed and approved:

- arbitrary HTTP request nodes
- arbitrary code execution
- shell/workspace/git/release nodes
- destructive delete/archive/bulk mutation nodes
- plaintext secret input fields
- cross-scope data copy nodes
- agent nodes with unrestricted write tools

## Implemented MVP enforcement

The backend includes a workflow node policy registry (`backend/src/workflows/workflow-security.policy.ts`) classifying known node types by risk and allowed scope, plus a runtime helper (`backend/src/workflows/workflow-security.runtime.ts`) that owns budgets and per-node re-checks.

Current enforcement points:

**Static / activation gate** (`WorkflowsService.updateDefinition`):
- Structural validation: duplicate ids, self-loops, dangling edges, scope/owner consistency (`validateGraph`).
- Policy validation: unknown types, blocked MVP risk classes, scope/type mismatches, `secretRefs` on non-secret-aware nodes (`workflowSecurityIssues`).
- Per-node Zod schema validation against the executor's `configSchema`.
- Definition size cap (`WORKFLOW_MAX_NODES_PER_DEFINITION`, default 100).

**Activation approval** (`workflow-definition.schema.ts` → `approvals[]`):
- Every transition into `ACTIVE` (and every runtime-affecting republish) appends an approval entry with `version`, `approvedAt`, `approvedByUserId/Username/Role` (from `RequestContext`), and a `riskSummary` (count per risk class + allowed node types).
- Approvals are append-only; the activation audit event references the latest entry.

**Runtime engine** (`WorkflowEngineService.runJob`):
- Defense-in-depth re-check of the snapshot's node against the current policy (`checkRuntimeNode`). Snapshots that were valid at activation but whose policy was later tightened fail closed.
- Run budget guard (`checkRunBudget`) on every job: caps `executedNodeCount` per run (`WORKFLOW_MAX_NODES_PER_RUN`, default 100) and total wall-clock duration (`WORKFLOW_MAX_RUN_DURATION_MS`, default 30 min). Exceeded budgets mark the node failed and fail the run with a stable error code (`node_count_exceeded` / `duration_exceeded`).
- `WorkflowRun.executedNodeCount` is incremented per job start and persisted so workers across the pool see a consistent count.

**Redaction at write time** (`backend/src/workflows/workflow-redaction.ts`):
- All persisted run data passes through `redact`/`redactValue`/`redactLogs` before being saved: `WorkflowNodeRun.outputSnapshot`, `WorkflowNodeRun.error`, `WorkflowNodeRun.logs`, `WorkflowRun.error`, and the downstream `WorkflowRun.context.nodes[*]` copy that subsequent nodes read.
- Per-line log redaction is also applied at append time inside the executor logger, so a crash between append and save cannot leak.
- The redactor masks sensitive keys (`authorization`, `apiKey`, `secret`, `token`, `password`, `passwd`, `credential`, `private-key`, `cookie`), Bearer tokens, `key=value` credentials, and (when secret resolution is added) known token literals registered for the run.

**Audit trail** (`AuditLogService`):
- `workflow.definition.created`, `workflow.definition.updated`, `workflow.definition.<status>` (active/paused/archived/draft), `workflow.definition.deleted`
- `workflow.activation.approved`, `workflow.activation.denied`, `workflow.validation.failed`
- `workflow.run.queued`, `workflow.run.started`, `workflow.run.succeeded`, `workflow.run.failed`, `workflow.run.cancelled`, `workflow.run.budget_exceeded`
- `workflow.node.started`, `workflow.node.succeeded`, `workflow.node.failed`, `workflow.node.waiting`
- `workflow.permission.denied` (runtime policy block)

Each audit entry carries `runId`/`definitionId`/`version`/`scope`/`projectId`/`customerId` in `meta`. Definition-level entries also resolve the actor via `RequestContext` (user/api-key trail handled by `AuditLogService` itself).

MVP allowed node families include manual/schedule/project/customer triggers, Todo safe writes, Knowledge/Manual/Changelog writes, User Question, Condition/Switch, Delay, Notification/Log, and scoped RAG search. Agent, secret, HTTP, workspace/git, and destructive nodes remain blocked.

## Runner enforcement checklist

Before each node execution:

1. Load the immutable run snapshot, not the latest mutable definition.
2. Confirm run status is executable and within runtime limits.
3. Confirm node type is registered and allowed for the run's approval policy.
4. Re-check actor/API key/scope permissions where applicable.
5. Resolve SecretRefs only inside the executor and register redaction values.
6. Execute with abort signal, timeout, and retry budget.
7. Persist sanitized input/output snapshots and logs.
8. Emit audit event.
9. Advance only through valid outgoing edges.

## UI implications

- Show a risk summary before activation.
- Mark blocked/risky nodes directly on the canvas.
- Display `hasSecretRef` and secret labels, never values.
- Show run audit trail and redacted node logs.
- For failed validation, explain the specific node and policy that blocked activation.

## Open questions

- Whether project editors may activate `agent-write` workflows or only project admins.
- How granular workflow API-key scopes should be: per node type, per risk class, or both.
- Whether external HTTP nodes should use named integration profiles instead of raw URLs.
- Whether signed workflow export/import should exist, and how secrets should be remapped.
