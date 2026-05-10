# Workflow Examples and Agent Guide

This page turns the Workflow concept into practical starting points for users and agents. It assumes the core model from [`workflows.md`](./workflows.md), the security rules from [`workflow-security.md`](./workflow-security.md), and the template/wizard specification from [`workflow-template-wizard.md`](./workflow-template-wizard.md).

## Workflow MVP in plain language

A DevGrimoire Workflow is a repeatable process with a trigger, one or more nodes, optional branches, and a run history. Use it when a single Todo or Recurring Task is not enough because the work needs multiple steps, an agent prompt, a user decision, or a retryable execution trail.

Good MVP workflows are small:

- one clear scope: project, customer, or system;
- one clear trigger: manual or schedule first;
- a short node chain with explicit outputs;
- no plaintext secrets in node configs;
- a visible run log that explains success, waiting, or failure.

## User handbook

### Create a workflow

1. Choose the scope: project, customer, or system.
2. Pick a template or start empty.
3. Configure the trigger.
4. Add nodes from the palette.
5. Connect nodes in the expected execution order.
6. Validate the graph.
7. Save as draft.
8. Run manually once before activating a schedule.

### Read a workflow run

A run should answer four questions quickly:

- What triggered it?
- Which node is currently active or failed?
- What did each node receive and return?
- What action should the user or agent take next?

Recommended run statuses:

- `queued`: accepted but not started yet.
- `running`: actively executing.
- `waiting_for_user`: paused until a user answers a question.
- `succeeded`: all required nodes finished.
- `failed`: unrecoverable error or retry limit reached.
- `cancelled`: stopped intentionally.

### Best practices

- Start with a manual trigger, then add a schedule after the workflow succeeds manually.
- Prefer project/customer-scoped workflows over system workflows.
- Keep node labels action-oriented: “Create release checklist”, “Ask for scope decision”, “Summarize blockers”.
- Store only secret references, never secret values.
- Make user questions specific enough to answer in one message.
- Treat workflow templates as starting points, not locked processes.

## Example workflow 1: Weekly project triage

Purpose: summarize project health and create follow-up Todos when needed.

Scope: `project`

Trigger:

```json
{
  "type": "schedule",
  "frequency": "weekly",
  "dayOfWeek": 1,
  "hour": 9
}
```

Nodes:

1. `todo.list`
   - filter: open/in-progress/review Todos for the project
2. `validation.list_recent`
   - optional in MVP; can be a no-op until validation reports exist
3. `chat.prompt`
   - prompt: “Summarize blockers, stale Todos, risky areas, and the top three next actions.”
4. `condition`
   - if blockers exist, continue to Todo creation
5. `todo.create`
   - create one compact follow-up Todo per confirmed blocker
6. `log.create`
   - store the triage summary in project logs

Expected output:

- A concise project health summary.
- Optional follow-up Todos with source link to the workflow run.
- A run history entry that agents can inspect later.

MVP boundary:

- The workflow may suggest follow-up Todos automatically, but destructive actions or broad reprioritization should require explicit user confirmation.

## Example workflow 2: Monthly customer check

Purpose: review a customer account for open questions, recent activity, monitoring issues, and next steps.

Scope: `customer`

Trigger:

```json
{
  "type": "schedule",
  "frequency": "monthly",
  "dayOfMonth": 1,
  "hour": 10
}
```

Nodes:

1. `customer.get`
   - load customer profile and linked projects
2. `todo.list`
   - filter customer-scoped open/in-progress Todos
3. `monitoring.list_status`
   - include configured checks when available
4. `environment.list`
   - list environments without exposing secret values
5. `chat.prompt`
   - prompt: “Create a monthly customer check summary: risks, open questions, stale work, and recommended next contact.”
6. `ask_user`
   - ask whether to create follow-up Todos or contact notes
7. `todo.create`
   - only if the user approves concrete follow-ups
8. `log.create`
   - save the summary

Expected output:

- Account health summary.
- Explicit user decision before creating customer-facing or follow-up work.
- No secret values in outputs.

MVP boundary:

- The workflow does not send emails or external messages. It only prepares internal DevGrimoire artifacts.

## Example workflow 3: Release checklist

Purpose: standardize release readiness before a project version is shipped.

Scope: `project`

Trigger:

```json
{
  "type": "manual",
  "label": "Start release checklist"
}
```

Nodes:

1. `release.get_or_create_draft`
   - select target release or create a draft
2. `workspace.exec_validation`
   - run configured checks such as tests, typecheck, lint, or build
3. `condition`
   - branch on validation success/failure
4. `changelog.create_or_update`
   - ensure release notes are present
5. `manual.check_updates`
   - suggest docs/manual updates when APIs or workflows changed
6. `ask_user`
   - ask for release approval if all checks pass
7. `release.update_status`
   - move to ready/released only after approval
8. `log.create`
   - persist the release checklist summary

Expected output:

- Validation result attached to the run.
- Changelog/doc-update reminders.
- Human approval before release status changes.

MVP boundary:

- Publishing, deployment, or external notifications should remain opt-in nodes with explicit permissions.

## Agent instructions

Agents should read workflows and runs before acting:

1. Load the WorkflowDefinition.
2. Load the latest relevant WorkflowRun and WorkflowNodeRun records.
3. Check scope and permissions before suggesting changes.
4. Summarize status in user language: current node, blocker, next safe action.
5. Never reveal secret values; mention only secret labels/refs.
6. For mutating operations, prefer preview/validation first.
7. If a run is failed, propose the smallest retry or fix path instead of rerunning everything blindly.

Suggested MCP/API capabilities for agents:

- `workflow_list`: find definitions in scope.
- `workflow_get`: inspect trigger, graph, version, and status.
- `workflow_validate`: explain graph errors before saving/running.
- `workflow_run_start`: start a manual run when allowed.
- `workflow_run_get`: inspect overall run status.
- `workflow_run_list`: find recent runs.
- `workflow_node_run_get_logs`: inspect node-level output and sanitized logs.

Write tools must stay separated from read tools. A read-only agent should still be able to explain workflow state and recommend next steps without starting or changing runs.

## Template catalog for MVP

Initial templates should be intentionally small:

| Template | Scope | Trigger | Main result |
| --- | --- | --- | --- |
| Weekly project triage | Project | Weekly schedule | Summary + optional follow-up Todos |
| Monthly customer check | Customer | Monthly schedule | Customer health summary + approved follow-ups |
| Release checklist | Project | Manual | Validation/checklist run + release readiness log |
| Agent research loop | Project | Manual | Research summary + proposed Todos after user confirmation |
| Backup/healthcheck reminder | System or project | Schedule | Internal notification/Todo when checks need attention |

Each template should include:

- a short description,
- required scope,
- configurable parameters,
- generated nodes,
- security notes,
- expected run output.

## UX copy suggestions

Empty workflow page:

> Automate repeatable project work with visible steps, safe approvals, and run history. Start from a small template and run it manually before scheduling.

Recurring Task comparison:

> Need one scheduled Todo or reminder? Use Recurring Tasks. Need multiple steps, branching, agent prompts, or replay? Use Workflows.

Run failure banner:

> This run stopped at “{nodeLabel}”. Review the sanitized error, adjust the workflow or inputs, then retry this node or start a new run.

Waiting for user banner:

> This workflow is paused until you answer “{question}”. The answer will be stored with the run history.
