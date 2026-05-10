# Workflow Templates and Creation Wizard

This document specifies the first DevGrimoire-native workflow templates and a guided wizard for creating valid workflows without starting from an empty canvas.

Related docs:

- [`workflows.md`](./workflows.md) — core domain model and MVP boundaries
- [`workflow-examples.md`](./workflow-examples.md) — handbook, example workflows, and agent guide
- [`workflow-security.md`](./workflow-security.md) — permissions, secrets, and audit expectations

## Goals

- Give users useful starting points instead of a blank automation canvas.
- Generate valid WorkflowDefinitions with safe defaults.
- Make scope, schedule, parameters, and permissions understandable before activation.
- Keep templates editable after creation.
- Reuse existing Recurring Tasks as simple one-action inspirations without forcing migration.

## Non-goals for MVP

- No marketplace or remote template registry.
- No arbitrary user-supplied JavaScript in templates.
- No template execution during preview.
- No secret values embedded in template definitions.
- No destructive nodes in built-in templates.

## Template model

Templates can be code-defined first and later moved into a database-backed catalog.

```ts
interface WorkflowTemplateDefinition {
  id: string;
  version: number;
  name: string;
  description: string;
  category: 'project' | 'customer' | 'operations' | 'agent';
  allowedScopes: Array<'project' | 'customer' | 'system'>;
  recommendedScope: 'project' | 'customer' | 'system';
  tags: string[];
  parameters: WorkflowTemplateParameter[];
  defaultTrigger: WorkflowTriggerTemplate;
  nodes: WorkflowNodeTemplate[];
  edges: WorkflowEdgeTemplate[];
  securityNotes: string[];
  expectedOutput: string;
}

interface WorkflowTemplateParameter {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'multiselect' | 'schedule' | 'entityRef';
  required: boolean;
  defaultValue?: unknown;
  options?: Array<{ value: string; label: string }>;
  helpText?: string;
}
```

Template expansion replaces parameter placeholders with user-selected values and creates a draft WorkflowDefinition. Expansion must validate the generated graph before saving.

## Wizard flow

### Step 1: Choose template

Show a compact catalog grouped by use case:

- Project operations
- Customer operations
- Release and validation
- Agent-assisted work
- Simple recurring-task style workflows

Each card shows:

- name,
- one-line description,
- recommended scope,
- trigger type,
- created artifacts,
- security notes badge when approvals are required.

### Step 2: Choose scope

Ask for the concrete scope required by the template:

- Project template → project selector required.
- Customer template → customer selector required.
- System template → admin permission required.

Validation:

- Project/customer id must exist and be visible to the actor.
- API keys must include workflow create permission for the selected scope.
- System templates are hidden unless allowed.

### Step 3: Configure parameters

Render template parameters as a simple form. Examples:

- schedule day/hour,
- Todo priority,
- tags,
- whether to ask before creating follow-up Todos,
- maximum number of suggested follow-ups,
- validation command profile.

Parameter form rules:

- Provide safe defaults.
- Explain fields in user language.
- Mask secret references and show labels only.
- Validate required fields before preview.

### Step 4: Preview generated workflow

Show a read-only preview before creation:

- trigger summary,
- node list,
- edges/branches,
- artifacts that may be created,
- required permissions,
- secrets referenced by label only,
- estimated risk level.

The preview should expose the expanded JSON for advanced users and agents, but with secret values redacted.

### Step 5: Save draft or activate

Default action: **Save as draft**.

Optional actions:

- Save draft and open canvas.
- Run once manually.
- Activate schedule after a successful manual run.

Activation should be explicit. For scheduled templates, default to inactive/draft until the user confirms.

## Built-in templates

### 1. Weekly project triage

Scope: `project`

Trigger: weekly schedule, default Monday 09:00.

Parameters:

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `dayOfWeek` | select | Monday | Schedule day |
| `hour` | number | 9 | Local hour |
| `includeReviewTodos` | boolean | true | Include review status in analysis |
| `maxFollowUps` | number | 3 | Hard cap for generated suggestions |
| `requireApproval` | boolean | true | Ask user before creating follow-up Todos |

Generated nodes:

1. `todo.list` — open/in-progress/review Todos in project.
2. `chat.prompt` — summarize stale work, blockers, and next actions.
3. `condition` — continue if follow-ups are suggested.
4. `ask_user` — request approval when `requireApproval` is true.
5. `todo.create` — create up to `maxFollowUps` follow-up Todos.
6. `log.create` — store triage summary.

Expected output: project health summary and optional approved follow-up Todos.

Security notes:

- No external communication.
- Todo creation is capped.
- User approval is enabled by default.

### 2. Monthly customer check

Scope: `customer`

Trigger: monthly schedule, default day 1 at 10:00.

Parameters:

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `dayOfMonth` | number | 1 | Month day, clamped to valid date |
| `hour` | number | 10 | Local hour |
| `includeMonitoring` | boolean | true | Include monitoring status if configured |
| `includeEnvironments` | boolean | true | List environments without secrets |
| `requireApproval` | boolean | true | Ask before creating follow-up Todos |

Generated nodes:

1. `customer.get` — load customer profile.
2. `todo.list` — customer-scoped open/in-progress Todos.
3. `monitoring.list_status` — optional monitoring summary.
4. `environment.list` — optional environment labels, no secret values.
5. `chat.prompt` — summarize account health and next contact points.
6. `ask_user` — approve follow-ups.
7. `todo.create` — create approved customer follow-up Todos.
8. `log.create` — save monthly check summary.

Expected output: customer health summary and approved next steps.

Security notes:

- Never sends emails/messages externally.
- Environment output must not include secret values.
- Follow-up creation requires approval by default.

### 3. Release checklist

Scope: `project`

Trigger: manual.

Parameters:

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `releaseId` | entityRef | optional | Existing release or create/select in run input |
| `validationProfile` | select | `default` | Maps to approved validation commands |
| `requireApproval` | boolean | true | Required before changing release status |
| `checkManuals` | boolean | true | Suggest docs/manual updates |

Generated nodes:

1. `release.get_or_create_draft` — resolve target release.
2. `workspace.exec_validation` — run approved validation profile.
3. `condition` — branch on validation result.
4. `changelog.create_or_update` — ensure release notes exist.
5. `manual.check_updates` — suggest docs updates.
6. `ask_user` — request release readiness approval.
7. `release.update_status` — update only after approval.
8. `log.create` — save checklist result.

Expected output: release readiness report with validation and documentation status.

Security notes:

- Validation commands must come from an allowlisted profile.
- Release status update requires approval by default.
- Deployment/publishing is intentionally out of scope.

### 4. Agent research loop

Scope: `project`

Trigger: manual.

Parameters:

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `researchQuestion` | string | required | Main question |
| `sources` | multiselect | knowledge, web | Enabled source types |
| `maxTodoSuggestions` | number | 5 | Cap proposed Todos |
| `requireApproval` | boolean | true | Required before creating Todos |

Generated nodes:

1. `rag.search` — search project knowledge/manuals/research.
2. `web.search` — optional web search when allowed.
3. `chat.prompt` — synthesize findings and uncertainty.
4. `ask_user` — ask for clarification if confidence is low.
5. `todo.create` — create approved follow-up Todos.
6. `research.create` — store research summary with sources.

Expected output: research note and optional approved Todo proposals.

Security notes:

- Web source usage must be visible in preview.
- Todo creation requires approval by default.
- Sources should be cited in the research entry.

### 5. Backup/healthcheck reminder

Scope: `system` or `project`

Trigger: schedule.

Parameters:

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `frequency` | select | weekly | Schedule frequency |
| `hour` | number | 8 | Local hour |
| `targetLabel` | string | required | Human-readable system/project target |
| `createTodoOnFailure` | boolean | true | Create internal Todo when checks fail |

Generated nodes:

1. `healthcheck.run` or `monitoring.list_status` — depending on scope and permissions.
2. `condition` — branch on failures.
3. `todo.create` or `notification.create` — create internal follow-up.
4. `log.create` — record outcome.

Expected output: check summary and internal follow-up if issues are found.

Security notes:

- System scope requires elevated/admin workflow permission.
- Logs must avoid credentials and host-sensitive details beyond approved labels.

## Recurring Task integration

The wizard may show existing Recurring Tasks as “simple schedule” inspirations:

- Use Recurring Tasks when the desired result is one repeated Todo or notification.
- Offer “Create workflow from recurring task” only as an explicit conversion preview.
- Generated workflow starts as draft by default.
- The source RecurringTask remains unchanged unless the user explicitly chooses to pause it.

See [`recurring-task-workflow-migration.md`](./recurring-task-workflow-migration.md) for the detailed migration plan.

## API sketch

Template endpoints should be additive and safe by default:

```http
GET /api/workflow-templates
GET /api/workflow-templates/:id
POST /api/workflow-templates/:id/preview
POST /api/workflow-templates/:id/create
```

Preview request:

```json
{
  "scope": "project",
  "projectId": "...",
  "parameters": {
    "dayOfWeek": 1,
    "hour": 9,
    "requireApproval": true
  }
}
```

Preview response:

```json
{
  "valid": true,
  "definitionPreview": {
    "scope": "project",
    "status": "draft",
    "trigger": { "type": "schedule" },
    "nodes": [],
    "edges": []
  },
  "warnings": [],
  "requiredPermissions": ["workflow:create", "todo:list", "log:create"]
}
```

Create request:

```json
{
  "scope": "project",
  "projectId": "...",
  "parameters": {},
  "openInCanvas": true,
  "activate": false
}
```

`activate` must default to `false`.

## MCP/chat tools

Read-safe tools:

- `workflow_template_list`
- `workflow_template_get`
- `workflow_template_preview`

Mutating tool:

- `workflow_template_create_workflow`

Mutating creation must:

- default to draft,
- require explicit scope,
- validate generated graph,
- return the new WorkflowDefinition id,
- never include secret values in the response.

## UI acceptance criteria

- At least three templates are visible in the catalog.
- Wizard creates a valid draft WorkflowDefinition from each MVP template.
- Preview clearly lists trigger, nodes, permissions, and possible created artifacts.
- Schedule activation is opt-in.
- Template-created workflows can be opened and edited in the canvas.
- Existing Recurring Tasks are presented as a simpler alternative or optional conversion source, not silently migrated.

## Agent acceptance criteria

- Agents can list and preview templates without write permission.
- Agents can explain which template fits a user request and why.
- Agents can create a draft from a template only when granted the mutating workflow permission.
- Agents must ask before activating schedules or creating workflows that can mutate project/customer data.
