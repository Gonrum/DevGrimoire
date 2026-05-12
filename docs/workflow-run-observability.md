# Workflow Run Observability, Replay, and Node Test Mode

Workflow runs must be easy to understand, debug, and safely retry. This design mirrors the best parts of tools like n8n: run history, per-node status, node outputs next to configuration, one-node test execution, and replay from known inputs.

## Goals

- Show a filterable run history by workflow, scope, status, actor, and time range.
- Render a run graph with status, timing, and retry/replay links per node.
- Expose node outputs, logs, and errors in an inspector without leaking secrets.
- Allow safe node test mode with sample input and dry-run/preflight behavior where possible.
- Support replay of a full run or continuation from a failed node while preserving auditability.
- Produce diagnostics that are understandable for users and structured enough for agents.

## Non-goals

- Do not replay destructive side effects by default.
- Do not expose raw secret values or full environment dumps in logs or outputs.
- Do not mutate existing run records during retry; create linked child runs/attempts instead.
- Do not allow node test mode for high-risk nodes without explicit permission and safeguards.

## Run history filters

The run history API/UI should support these filters:

| Filter | Purpose |
| --- | --- |
| `workflowId` | Inspect one workflow's execution history. |
| `scopeType` + `scopeId` | Show project/customer/todo related runs. |
| `status` | Find failed, running, cancelled, or completed runs. |
| `triggerType` | Distinguish manual, schedule, webhook, agent, and system runs. |
| `actorId` / `apiKeyId` | Audit who or what started the run. |
| `startedAfter` / `startedBefore` | Time-range debugging. |
| `hasRetries` / `parentRunId` | Inspect replay trees. |

## Status model

```ts
type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'timed_out';

type WorkflowNodeRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'timed_out'
  | 'cancelled';
```

A workflow run owns immutable node-run attempts. Retrying creates a new run or child node attempt linked to the original.

## Data model additions

```ts
interface WorkflowRun {
  _id: ObjectId;
  workflowId: ObjectId;
  workflowVersion: number;
  projectId: ObjectId;
  scope?: { type: 'project' | 'customer' | 'todo' | 'release'; id: ObjectId };
  status: WorkflowRunStatus;
  trigger: { type: 'manual' | 'schedule' | 'webhook' | 'agent' | 'system'; id?: string };
  parentRunId?: ObjectId;
  replayOfRunId?: ObjectId;
  replayMode?: 'full' | 'from_node' | 'single_node_test';
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  summary?: string;
  errorSummary?: string;
  createdBy?: ObjectId;
}

interface WorkflowNodeRun {
  _id: ObjectId;
  runId: ObjectId;
  nodeId: string;
  nodeType: string;
  status: WorkflowNodeRunStatus;
  attempt: number;
  startedAt?: Date;
  finishedAt?: Date;
  durationMs?: number;
  inputPreview?: SafeJsonPreview;
  outputPreview?: SafeJsonPreview;
  logExcerpt?: string;
  error?: WorkflowNodeError;
  replayable: boolean;
  testable: boolean;
}

interface WorkflowNodeError {
  code: string;
  message: string;
  userMessage: string;
  technicalDetails?: string;
  retryHint?: string;
}
```

`SafeJsonPreview` is a truncated/masked JSON value with metadata such as `truncated: true` and `maskedPaths`.

## Implemented API slice

The backend exposes compact inspection and safe node-test endpoints for UI and agent debugging:

- `GET /api/workflows/runs/:id/inspection`
- MCP tool `workflow_run_inspect`
- `POST /api/workflows/nodes/test`
- MCP tool `workflow_node_test`

Inspection returns the run identity/status, node-run status counts, failed/waiting node ids, and per-node timing/error/input/output/log previews. Previews are truncated and mask common secret-bearing keys and bearer/token-like strings before returning data, so the inspector can be useful without defaulting to raw node-run payloads.

Node test mode currently performs schema/scope validation for every node type, executes only safe trigger/control nodes against an isolated in-memory context, and returns masked output/waiting/error/log previews. The same behavior is available to agents through `workflow_node_test`. Action and agent nodes stay validation-only until dry-run adapters or sandbox targets exist.

Raw run and node-run endpoints remain available for existing tooling, but UI and agent-debugging surfaces should prefer the inspection endpoint/tool and node-test endpoint for the first observability view.

## Graph run view

Each node in the graph should show:

- status color and icon
- duration
- attempt count
- compact error marker
- output availability marker
- replay/test availability marker

Clicking a node opens the inspector with tabs:

1. **Config** — node configuration at workflow version used by the run.
2. **Input** — masked input preview.
3. **Output** — masked output preview.
4. **Logs** — masked log excerpt and artifact links.
5. **Error** — user-friendly message plus agent-facing structured details.
6. **Replay/Test** — allowed actions with preflight warnings.

## Node output and log safety

Before storing or displaying node inputs, outputs, and logs:

- Mask common secret keys and token patterns.
- Mask configured sensitive JSON paths from node definitions.
- Truncate large values and store artifact references for optional raw-safe attachments.
- Never show decrypted secret values, API keys, JWTs, private keys, passwords, or full env blocks.
- Include `maskedPaths` so users know content was hidden intentionally.

## Node test mode

Node test mode executes a single node with sample input and isolated context.

### Eligibility

| Node risk | Default test mode |
| --- | --- |
| Pure transform/read-only | Allowed |
| Read external system | Allowed with scope checks and timeout |
| Writes project/customer data | Dry-run/preview only by default |
| Sends external messages/webhooks | Disabled unless explicit sandbox target exists |
| Deletes/destructive changes | Disabled |

### Test mode payload

```json
{
  "workflowId": "...",
  "nodeId": "summarize-todos",
  "sampleInput": { "todos": [] },
  "mode": "dry_run",
  "maskOutputs": true
}
```

The result should be stored as a `WorkflowRun` with `replayMode = 'single_node_test'` so test executions appear in history without being confused with production runs.

## Replay and retry semantics

- **Full replay:** create a new child run with the same workflow version and original trigger input unless user chooses latest workflow version.
- **Retry failed node:** create a child run starting from the failed node using stored safe input preview or a user-provided replacement input.
- **Continue from failed node:** allowed only if previous successful node outputs are available and safe to reuse.
- **Side-effect guard:** nodes marked non-idempotent require confirmation or dry-run support.
- **Audit:** every replay stores `parentRunId`, `replayOfRunId`, selected node, actor, and reason.

## Error diagnostics

Every failed node should produce two layers of diagnostic text:

- `userMessage`: plain-language explanation and next action.
- `technicalDetails`: compact structured details for agents/developers.

Example:

```json
{
  "code": "WORKSPACE_COMMAND_FAILED",
  "userMessage": "The validation command failed. Review the test output and fix the failing suite before marking the todo done.",
  "technicalDetails": "exitCode=1 parser=vitest failedTests=2",
  "retryHint": "After fixing the tests, replay from node run-validation."
}
```

## API sketch

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/workflow-runs?workflowId=&scopeType=&scopeId=&status=&startedAfter=&startedBefore=` | Filter run history |
| `GET` | `/api/workflow-runs/:id` | Run summary with node statuses |
| `GET` | `/api/workflow-runs/:id/nodes/:nodeId` | Node run inspector data |
| `POST` | `/api/workflow-runs/:id/replay` | Full replay or replay from node |
| `POST` | `/api/workflows/:id/nodes/:nodeId/test` | Execute node test mode |
| `POST` | `/api/workflow-runs/:id/cancel` | Cancel queued/running run |

## MCP and agent tools

- `workflow_run_list` — read filtered run history.
- `workflow_run_get` — read run graph summary.
- `workflow_node_run_get` — read masked node inspector data.
- `workflow_run_replay` — write, allowlisted, side-effect guarded.
- `workflow_node_test` — write, allowlisted, risk-class guarded.

Agents should prefer reading run/node details before replaying. Replay of non-idempotent or external-write nodes should ask for user confirmation unless a safe sandbox/dry-run mode is configured.

## UI acceptance mapping

- **Why did it fail?** Run graph highlights failed node; inspector shows user message, technical details, logs, and retry hint.
- **Outputs are nachvollziehbar:** input/output previews are stored per node run and rendered alongside config.
- **Replay/Retry creates own entries:** `parentRunId`, `replayOfRunId`, and `replayMode` link child runs to originals.
- **Sensitive data masked:** all previews/logs pass through masking/truncation and expose `maskedPaths` metadata.

## Implementation order

1. Extend workflow run/node-run schemas with replay links, safe previews, attempts, and diagnostic fields.
2. Add masking/truncation utility for node inputs, outputs, and logs.
3. Add run history and node inspector REST endpoints.
4. Add run graph UI with inspector tabs.
5. Add node test mode for read-only/transform nodes.
6. Add replay endpoints with idempotency/side-effect guards.
7. Add MCP tools after permission checks are documented and enforced.
