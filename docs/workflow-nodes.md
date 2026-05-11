# DevGrimoire-Native Workflow Nodes (T-252)

Design für den ersten produktiven Node-Katalog des Workflow-Moduls (M-31). Setzt auf der T-250-Engine auf und liefert die Datenquelle für T-251 (Canvas-UI).

Verwandte Dokumente:
- [Workflow Runner](workflow-runner.md) — Engine (T-250)
- [Workflow-Security](workflow-security.md) — Policy-Modell (T-256)
- [Workflow-Run-Observability](workflow-run-observability.md) — Replay-UI (T-254)

## Scope

**In-scope**:
- 11 neue Node-Executors über 4 Kategorien (trigger, action, control, agent)
- NodeMetadata-System mit zod-basiertem `configSchema` und JSON-Schema-Export
- Neuer Endpoint `GET /api/workflows/node-types` als Datenquelle für die Canvas-UI (T-251)
- Activation-Time-Schema-Validierung pro Node-Config
- Persistente Delay-Wartezeiten (crash-fest) via neuer `WorkflowDelayScheduler`
- Event-Trigger-Dispatch via neuer `WorkflowEventListener`
- Dedizierter Workflow-Agent-LLM-Endpoint mit Tool-Calling und per-Node-Allowlist
- Settings-UI-Sektion für den Agent-Endpoint

**Out-of-scope**:
- Canvas-UI selbst → T-251 (konsumiert den `/node-types`-Endpoint)
- HTTP-Request-Node, Workspace/Git/Release-Nodes, Secret-aware-Integrations → spätere Tickets
- Replay einzelner Nodes mit modifiziertem Input → T-254
- Erweitertes Permission-/Approval-Modell für `agent.task` → T-256

## Architektur

```
backend/src/workflows/
├── engine/
│   ├── node-metadata.ts              # NodeMetadata interface + zod→JSON-Schema helper
│   ├── workflow-event-listener.service.ts
│   ├── workflow-delay-scheduler.ts
│   └── (T-250 files unverändert)
├── workflow-node-types.controller.ts # GET /api/workflows/node-types
├── workflow-agent.service.ts         # eigener LLM-Endpoint + Tool-Loop
├── workflow-agent.controller.ts      # GET/PUT /api/workflows/agent-config
└── nodes/
    ├── trigger-project-event.executor.ts
    ├── trigger-customer-event.executor.ts
    ├── action-todo-update.executor.ts
    ├── action-todo-comment.executor.ts
    ├── action-todo-link-milestone.executor.ts
    ├── action-knowledge-create.executor.ts
    ├── action-manual-create.executor.ts
    ├── action-changelog-add.executor.ts
    ├── action-user-question.executor.ts
    ├── control-condition.executor.ts
    ├── control-delay.executor.ts
    ├── agent-task.executor.ts
    └── condition-ops.ts              # pure helper (op-Evaluation)
```

Alle 11 neuen Executors registrieren sich in `WorkflowsModule.onModuleInit`. `WorkflowEventListener`, `WorkflowDelayScheduler`, `WorkflowAgentService` werden Provider im selben Modul. Die T-250-Executors (`trigger.manual`, `trigger.schedule`, `action.log`, `action.todo-create`, `action.notify`) bekommen retrospektiv NodeMetadata-Einträge, damit der Katalog vollständig ist.

## NodeMetadata + Endpoint

`backend/src/workflows/engine/node-metadata.ts`:

```ts
import { ZodSchema } from 'zod';
import { WorkflowScope } from '../schemas/workflow-definition.schema';

export interface NodeMetadata {
  type: string;
  category: 'trigger' | 'action' | 'control' | 'agent';
  label: string;
  description: string;
  allowedScopes: WorkflowScope[];
  configSchema: ZodSchema;
  outputs: Record<string, string>;
  branches?: Array<'success' | 'failure' | 'custom'>;
}
```

`NodeExecutor` Interface erweitert um `readonly metadata: NodeMetadata`. `NodeRegistry` exponiert `getMetadata(type)` und `listMetadata()`.

**Endpoint** `GET /api/workflows/node-types`:
```json
[
  {
    "type": "action.todo-update",
    "category": "action",
    "label": "Todo updaten",
    "description": "...",
    "allowedScopes": ["project", "customer"],
    "configJsonSchema": { /* aus zod-to-json-schema */ },
    "outputs": { "todoId": "string", "updated": "boolean" },
    "branches": ["success", "failure"]
  },
  ...
]
```

Conversion via `zod-to-json-schema` (neue Dep). MCP-Equivalent: `workflow_node_types_list` (read-only).

**Activation-Time-Validation**: `updateDefinition` bei `status→active` iteriert nodes, holt `registry.getMetadata(node.type).configSchema`, ruft `.safeParse(node.config)`. Fehler → `BadRequestException` mit Pfad+Issue (zod path). Folgt der Security-Policy-Prüfung; beide müssen passen.

## Datenstrukturen — Schema-Erweiterungen

**WorkflowNodeRun.waitingFor** wird zur Union:
```ts
waitingFor?:
  | { type: 'question'; refId: ObjectId }
  | { type: 'delay'; resumeAt: Date };
```

Neuer Index für den Delay-Scheduler-Pick:
```ts
WorkflowNodeRunSchema.index({ 'waitingFor.type': 1, 'waitingFor.resumeAt': 1, status: 1 });
```

**WorkflowRunStatus** Enum erhält neuen Wert `WAITING_FOR_TIMER = 'waiting_for_timer'`. Begründung: User-Resume-Semantik (`WAITING_FOR_USER`) passt nicht für Timer-Waits. Trennung erlaubt UI-seitige Filterung (z.B. "alle Runs, die auf User warten" vs "alle Runs im Timer-Wait").

**WorkflowRun.context** erhält klare Convention für Input:
- `context.input` — Trigger-Payload (manual-startRun `input`, schedule-Trigger leer, event-Trigger der Event-Payload)
- `context.nodes[nodeId]` — Node-Outputs (Bestand)

`WorkflowsService.startRun` schreibt `dto.input` (existiert bereits als DTO-Feld) ab sofort in `run.context.input`. Heute landet das Feld in `trigger`-Objekt — die Konvention wird angepasst, ist aber rückwärtskompatibel: bestehende Runs ohne `context.input` werden vom Engine unverändert behandelt.

## Mini-Action-Executors

Sieben Executors, jeder ein Service-Aufruf. Pro Datei eine Klasse. Alle nutzen `expandConfig(ctx.config, ctx.runContext)` für Template-Auflösung.

| Type | Service-Call | Output | Branches |
|---|---|---|---|
| `action.todo-update` | `TodosService.update(todoId, dto)` | `{ todoId, updated }` | success/failure |
| `action.todo-comment` | `TodosService.addComment(todoId, text, author)` | `{ todoId, commentIndex }` | success/failure |
| `action.todo-link-milestone` | `TodosService.update(todoId, { milestoneId })` | `{ todoId, milestoneId }` | success/failure |
| `action.knowledge-create` | `KnowledgeService.save(dto)` | `{ knowledgeId }` | success/failure |
| `action.manual-create` | `ManualsService.create(dto)` | `{ manualId }` | success/failure |
| `action.changelog-add` | `ChangelogService.add(dto)` | `{ changelogId, version }` | success/failure |
| `action.user-question` | `ctx.askUser(question, options)` | nach resume: `{ answer, optionIndex }` | success/failure/custom (via branchMap) |

Common-Config-Felder:
- `projectId`/`customerId` werden aus `ctx.run.scope` inferiert wenn nicht explizit gesetzt.
- Service-Fehler → `status: 'failed'` mit `error.code` aus dem Service (Mapping in jedem Executor).

**`action.user-question` Besonderheit**: Engine-`handleQuestionAnswered` muss den `branchMap` aus `node.config` lesen und an `applyResult` weitergeben. Heute setzt `handleQuestionAnswered` `branch` nicht — Anpassung nötig:

```ts
const cfg = (node.config ?? {}) as { branchMap?: Record<string, 'success'|'failure'|'custom'> };
const branch = cfg.branchMap?.[payload.answer] ?? 'success';
await this.applyResult(run, nodeRun, node, {
  status: 'success',
  output: { answer: payload.answer, optionIndex: /* lookup */ },
  branch,
});
```

config: `{ question: string, options?: string[], branchMap?: Record<string,Branch>, timeoutSeconds?: number }`

## Control-Flow-Executors

### `control.delay`

config (zod oneOf):
- `{ delayMs: number }` (1ms – 7 Tage als hartes Limit), ODER
- `{ until: string }` (ISO-Date, in der Zukunft)

Verhalten:
```ts
const resumeAt = config.delayMs
  ? new Date(Date.now() + config.delayMs)
  : new Date(config.until);
return { status: 'waiting', waitingFor: { type: 'delay', resumeAt } };
```

**Engine-Anpassung**: `applyResult` für `result.status === 'waiting'` mit `waitingFor.type === 'delay'` setzt `run.status` NICHT auf `WAITING_FOR_USER`, sondern auf `WAITING_FOR_TIMER` (neuer Enum-Wert). Begründung: ein User-Resume-Mechanismus passt semantisch nicht für Timer. `WorkflowRunStatus` enum bekommt `WAITING_FOR_TIMER = 'waiting_for_timer'`.

Alternative betrachtet und verworfen: Heute existing `WAITING_FOR_USER` für alle Wait-Modi recyceln. Pro: kein Enum-Change. Contra: irreführende Semantik in Run-Listen, schwerer zu filtern in der UI.

**Resume**: Neuer Provider `WorkflowDelayScheduler` im WorkflowsModule:

```ts
@Cron('*/15 * * * * *')   // alle 15s
async tick() {
  if (process.env.WORKFLOW_SCHEDULER_DISABLED === 'true') return;
  const due = await this.nodeRunModel.find({
    'waitingFor.type': 'delay',
    'waitingFor.resumeAt': { $lte: new Date() },
    status: 'waiting',
  }).limit(50).exec();
  for (const nr of due) await this.engine.resumeDelayedNode(nr._id);
}
```

`WorkflowEngineService.resumeDelayedNode(nodeRunId)`:
- Lädt nodeRun + run + node (aus snapshot)
- Setzt run.status zurück auf `RUNNING`, nodeRun.waitingFor auf undefined
- Ruft `applyResult(run, nodeRun, node, { status: 'success', output: { resumedAt, waitedMs } })`
- Wiederverwendet den existing applyResult-Path für next-Nodes-Berechnung

allowedScopes: alle. branches: `['success']`.

Output: `{ resumedAt: string, waitedMs: number }`

### `control.condition`

config:
```ts
{
  cases: Array<{
    when: {
      path: string;                            // dot-path in run.context
      op: 'eq'|'ne'|'gt'|'lt'|'gte'|'lte'|'contains'|'exists'|'truthy';
      value?: unknown;
    };
    branch: 'success'|'failure'|'custom';
  }>;
  default?: 'success'|'failure'|'custom';     // wenn nichts matched, default 'failure'
}
```

Executor:
```ts
async execute(ctx) {
  for (const [idx, c] of ctx.config.cases.entries()) {
    const lhs = lookupPath(c.when.path, ctx.runContext);
    if (evalOp(lhs, c.when.op, c.when.value)) {
      return {
        status: 'success',
        output: { matchedCase: idx, matchedPath: c.when.path, lhs },
        branch: c.branch,
      };
    }
  }
  return {
    status: 'success',
    output: { matchedCase: null },
    branch: ctx.config.default ?? 'failure',
  };
}
```

`lookupPath` ist im `nodes/template.ts` Module exportiert (heute privates `lookup` — wird `export` gemacht). `evalOp` in `nodes/condition-ops.ts`:

```ts
export function evalOp(lhs: unknown, op: string, rhs: unknown): boolean {
  switch (op) {
    case 'eq': return lhs === rhs;
    case 'ne': return lhs !== rhs;
    case 'gt': return typeof lhs === 'number' && typeof rhs === 'number' && lhs > rhs;
    case 'lt': return typeof lhs === 'number' && typeof rhs === 'number' && lhs < rhs;
    case 'gte': return typeof lhs === 'number' && typeof rhs === 'number' && lhs >= rhs;
    case 'lte': return typeof lhs === 'number' && typeof rhs === 'number' && lhs <= rhs;
    case 'contains':
      if (typeof lhs === 'string' && typeof rhs === 'string') return lhs.includes(rhs);
      if (Array.isArray(lhs)) return lhs.includes(rhs);
      return false;
    case 'exists': return lhs !== undefined && lhs !== null;
    case 'truthy': return Boolean(lhs);
    default: return false;
  }
}
```

allowedScopes: alle. branches: `['success', 'failure', 'custom']`.

## Event-Trigger

Zwei Executor-Klassen (`trigger.project_event`, `trigger.customer_event`), no-op am Run-Start. Output: `{ event: ctx.runContext.input.event }` (Folge-Nodes können `{{nodes.t.event.entityId}}` referenzieren).

config:
```ts
{
  entity: 'todo'|'milestone'|'knowledge'|'manual'|'changelog'|'schema'|'feature'|'dependency'|'environment'|'secret'|'workflow-definition'|'workflow-run'|'*';
  action: 'created'|'updated'|'deleted'|'*';
  filter?: {
    tag?: string;
    status?: string;
    milestoneId?: string;
  };
}
```

allowedScopes: project_event → nur `project`, customer_event → nur `customer`.

**WorkflowEventListener** (`backend/src/workflows/engine/workflow-event-listener.service.ts`):

```ts
@OnEvent(PROJECT_CHANGED)
async handleProjectChange(payload: ProjectChangedPayload): Promise<void> {
  if (!payload.projectId && !payload.customerId) return;
  const scope = payload.projectId ? WorkflowScope.PROJECT : WorkflowScope.CUSTOMER;
  const triggerType = scope === WorkflowScope.PROJECT ? 'trigger.project_event' : 'trigger.customer_event';

  const candidates = await this.definitionModel.find({
    scope,
    status: WorkflowStatus.ACTIVE,
    'nodes.type': triggerType,
    ...(payload.projectId
      ? { projectId: new Types.ObjectId(payload.projectId) }
      : { customerId: new Types.ObjectId(payload.customerId!) }),
  }).exec();

  for (const def of candidates) {
    for (const node of def.nodes) {
      if (node.type !== triggerType) continue;
      if (!this.matches(node.config as Record<string, unknown>, payload)) continue;
      try {
        await this.workflowsService.startRun({
          definitionId: def._id.toString(),
          triggeredBy: { type: 'event' },
          input: { event: payload, matchedNodeId: node.id },
        } as never);
      } catch (err) {
        this.logger.warn(`event-trigger failed for ${def.name}: ${(err as Error).message}`);
      }
    }
  }
}

private matches(config: Record<string, unknown>, ev: ProjectChangedPayload): boolean {
  const wantEntity = config.entity as string ?? '*';
  const wantAction = config.action as string ?? '*';
  if (wantEntity !== '*' && wantEntity !== ev.entity) return false;
  if (wantAction !== '*' && wantAction !== ev.action) return false;
  return true;  // filter.tag/status/milestoneId wird per condition.switch downstream geprüft
}
```

**Idempotenz**: keine, da PROJECT_CHANGED single-emit ist. Falls Edge-Cases auftreten, später `triggeredBy.eventId` + sparse-unique-Index. Heute YAGNI.

## Agent-Task-Node

**Settings**: neuer encrypted-Eintrag `workflow_agent_endpoint_v1`. Shape:
```ts
{
  provider: 'lmstudio'|'openai-compatible'|'openai'|'anthropic';
  url: string;
  model: string;
  apiKey?: string;          // encrypted at rest via SECRETS_ENCRYPTION_KEY
  toolsEnabled: boolean;
  maxToolIterations: number; // default 5
}
```

REST:
- `GET /api/workflows/agent-config` → `{ provider, url, model, hasApiKey, toolsEnabled, maxToolIterations }` (kein Secret)
- `PUT /api/workflows/agent-config` → setzt/aktualisiert (Admin-only)

Frontend: existing Settings-Seite bekommt eine "Workflow Agent LLM"-Sektion analog zur Chat-LLM-Sektion. ~80 LOC zusätzlich, Provider-Dropdown-Komponente reused.

**`workflow-agent.service.ts`**:

```ts
@Injectable()
export class WorkflowAgentService {
  constructor(
    private readonly settings: SettingsService,
    private readonly encryption: EncryptionService,
    private readonly chatLlm: ChatLlmService,        // reuse provider-dispatch
    private readonly toolDispatcher: McpToolDispatcher,
  ) {}

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
  }>;

  private async loadEndpoint(): Promise<WorkflowAgentEndpoint | null>;
}
```

**Tool-Loop**:
1. Initial: `messages = [{system}, {user}]`, `tools = mapAllowlistToOpenAIFormat(allowedTools)`
2. Call LLM via `chatLlm.callRaw(endpoint, messages, tools)` (existing helper, refactor falls nötig)
3. Wenn Response `tool_use`: validate gegen Allowlist (intersect mit `WORKFLOW_AGENT_TOOL_ALLOWLIST` env), dispatch via `McpToolDispatcher.invoke(tool, args, callerScope)`. Append `tool_result` an messages. Goto 2.
4. Wenn text-response: returnen
5. Hard-stop bei `maxToolIterations` Limit mit error

**Tool-Allowlist-Sicherheit**:
- Env `WORKFLOW_AGENT_TOOL_ALLOWLIST` (Default: alle Tools matching `_get|_list|_search$` suffix, plus expliziter `rag_search`, `knowledge_search`, `project_get`, `todo_get`, `schema_list`).
- Effektive Allowlist pro Run = `node.config.allowedTools ∩ WORKFLOW_AGENT_TOOL_ALLOWLIST`.
- Tools werden mit `callerScope` aufgerufen → MCP-internal Permission-Check (heute permissiv, T-256 verschärft).

**Agent-Task-Executor** (`agent-task.executor.ts`):

config:
```ts
{
  prompt: string;
  systemPrompt?: string;
  allowedTools?: string[];
  timeoutMs?: number;
  maxToolIterations?: number;
}
```

Output: `{ response: string, iterations: number, toolCalls: [...], tokensIn?, tokensOut?, model }`

allowedScopes: project, customer. branches: success/failure.

Error-Codes: `no_agent_endpoint`, `llm_error`, `tool_loop_limit`, `tool_dispatch_error`, `timeout`.

## API/MCP-Ergänzungen

**Neue REST**:
- `GET /api/workflows/node-types`
- `GET /api/workflows/agent-config`
- `PUT /api/workflows/agent-config`

**Neue MCP-Tools**:
- `workflow_node_types_list` — read-only Katalog (gleicher Inhalt wie REST)

Keine MCP-Tools für die Agent-Config (gehört in die Settings-UI).

## Test-Strategie

Folgt der `.cjs`-Konvention (siehe T-250).

### Pure-Logic-Check
`backend/scripts/workflow-nodes-units-check.cjs`:
- **NodeMetadata** pro neuem Executor: 2 Assertions (valid config passes, broken config fails mit erwarteter zod-Issue)
- **condition-ops** helper: 9 Assertions (pro Op je ein truthy/falsy Fall plus boolean coercion edge cases)
- **event-listener.matches**: 5 Assertions (entity match/mismatch, action match/mismatch, '*' wildcard)
- **workflow-agent.service** mit Mock-fetch: 4 Assertions (single-shot ohne tools, ein-iteration tool-loop, tool-loop hits maxToolIterations, allowlist filtert disallowed tool)
- **lookupPath** (Re-Export aus template.ts): 3 Assertions (existing, deep, missing path)

Insgesamt ~50 Assertions in einer .cjs-Datei. Registriert als `npm run check:workflow-nodes-units`.

### Engine-Integration-Check
`backend/scripts/workflow-nodes-engine-check.cjs` — HTTP gegen laufendes Backend:

**Scenario A — delay + condition + question**:
1. Workflow `trigger.manual → action.todo-create → control.delay(2s) → control.condition(check nodes.todo.todoId exists) → action.user-question → action.todo-comment`
2. POST /api/workflows/runs, polle bis Run-Status `waiting_for_user`
3. Lese das offene Question via `GET /api/questions?todoId=...`
4. Antworte via `PUT /api/questions/:id` mit answer
5. Polle bis `succeeded`
6. Asserte: 6 NodeRuns succeeded, durations für delay >= 2000ms, todo-comment-Text enthält die Antwort
7. Cleanup (todo + workflow delete)

**Scenario B — event trigger**:
1. Workflow A: `trigger.project_event(entity:todo,action:created) → action.log(message: 'caught {{input.event.entityId}}')`, status active
2. POST /api/todos `{...}` (separates Test-Todo, das den Event auslöst)
3. Polle `GET /api/workflows/runs/list?definitionId=A`, erwarte mind. 1 Run
4. Asserte Run-Status `succeeded`, Run-Context-Input enthält den Event-Payload, log-NodeRun hat den entityId im Output
5. Cleanup: workflow + test-todo

**Scenario C — agent.task** (opt-in via `DEVGRIMOIRE_WORKFLOW_AGENT_E2E=true`):
1. Erwartet vorkonfigurierten Agent-Endpoint (skip-with-message wenn nicht gesetzt)
2. Workflow `trigger.manual → agent.task(prompt='Antworte mit dem Wort: PONG') → control.condition(check nodes.agent.response contains 'PONG') → action.log`
3. Polle bis succeeded
4. Asserte response existiert, condition branched korrekt

Registriert als `npm run check:workflow-nodes-engine`.

### Lint + manuelle Verifikation
- `nest build` exit 0
- Alle 4 Check-Scripts grün
- Rebuild `docker compose up -d --build backend`
- Manueller agent.task-Smoke wenn LLM-Endpoint zur Hand
- T-251 wird später den `/node-types`-Endpoint konsumieren — Smoke-Test: `curl /api/workflows/node-types | jq 'length'` ≥ 16 (5 T-250 + 11 T-252)

## Akzeptanzkriterien — Verifikations-Mapping

| Akzeptanz (aus T-252) | Verifikation |
|---|---|
| Node-Katalog ist dokumentiert | `docs/workflow-nodes.md`, Knowledge-Eintrag, Manual-Seite |
| MVP-Nodes haben klare Input-/Output-Schemas | `GET /api/workflows/node-types` liefert `configJsonSchema` + `outputs`; zod-Validierung am Activation-Gate; check-script asserted Katalog ≥ 16 Einträge |
| UI zeigt nur gültige Konfigurationsfelder | Katalog-Endpoint + Settings-UI-Sektion für Agent-Config liefern die "UI-Quelle"; Canvas-Form-Rendering in T-251 konsumiert den Endpoint |
| Agent Task funktioniert im Runner end-to-end | Scenario C im Integration-Check (opt-in); Settings-UI ermöglicht Konfiguration; Unit-Check für Service-Logik (Mock-fetch) |
| User Question funktioniert im Runner end-to-end | Scenario A im Integration-Check |

## Konfiguration (.env)

```env
WORKFLOW_AGENT_TOOL_ALLOWLIST=knowledge_search,rag_search,project_get,todo_get,schema_list  # CSV; matched gegen exakte Tool-Namen
# Bestehende:
WORKFLOW_WORKER_CONCURRENCY=4
WORKFLOW_SCHEDULER_DISABLED=false
WORKFLOW_RUN_RECOVERY_AGE_MS=300000
WORKFLOW_NODE_LOG_CAP=200
```

Suffix-Pattern (`_get|_list|_search`) wird zusätzlich automatisch erlaubt — die env-Variable ist eine Whitelist für Read-Only-Tools, die nicht dem Suffix folgen.

## Offene Punkte für Folge-Tickets

- HTTP-Request-Node, Workspace/Git/Release-Nodes, Secret-aware-Integrations (eigene Tickets)
- T-256 übernimmt die Workflow-Security-Policy und erweitert sie um Per-Scope-Tool-Allowlists für Agent-Task-Nodes
- T-254 Replay-UI konsumiert die hier gepflegte `outputs`-Metadata für Inspection-Forms
- T-251 Canvas-UI konsumiert den `/node-types`-Endpoint
