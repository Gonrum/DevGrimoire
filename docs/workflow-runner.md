# Workflow Runner / Scheduler (T-250)

Design für die Ausführungsengine des Workflow-Moduls (M-31). Setzt auf der bestehenden Foundation aus T-248 (Schemas) und T-249 (REST/MCP) auf.

Verwandte Dokumente:
- [Workflows-Überblick](workflows.md)
- [Workflow-Beispiele](workflow-examples.md)
- [Run-Observability](workflow-run-observability.md) — Detailtiefe Replay/Monitor (T-254)
- [Workflow-Security](workflow-security.md) — Permission/Secret-Modell (T-256)
- [Recurring-Task-Migration](recurring-task-workflow-migration.md) — Koexistenz (T-255)

## Scope T-250

**In-scope**:
- Engine: DAG-Walker, Worker-Pool, Definition-Locks, Lifecycle-Transitions
- Persistente Queue (DB als Quelle, In-Memory als Cache, Crash-Recovery)
- Scheduler mit cron + intervalMinutes + Catch-up
- Retry (Auto + manueller Replay)
- Resume via bestehende `question`-Entität
- Mini-Node-Katalog: `trigger.manual`, `trigger.schedule`, `action.log`, `action.todo-create`, `action.notify`

**Out-of-scope** (eigene Tickets):
- Vollständiger Node-Katalog → T-252
- Frontend-Canvas → T-251
- Templates/Wizard → T-253
- Recurring-Task-Migration → T-255
- Security/Permissions → T-256
- Erweiterte Run-Observability/Replay-UI → T-254

## Architektur

Module-Struktur unter `backend/src/workflows/`:

```
workflows/
├── engine/
│   ├── workflow-engine.service.ts      # Orchestrator: Run-Lifecycle, Recovery
│   ├── workflow-queue.service.ts       # In-Memory PriorityQueue + DB-Recovery
│   ├── workflow-worker.pool.ts         # N Worker, Definition-Locks
│   ├── workflow-scheduler.service.ts   # @Cron(EVERY_MINUTE), cron + interval
│   ├── node-registry.ts                # Map<nodeType, NodeExecutor>
│   ├── node-executor.interface.ts      # execute(ctx) → NodeResult
│   └── graph-walker.ts                 # next-Nodes-Berechnung, branch/condition
├── nodes/
│   ├── trigger-manual.executor.ts
│   ├── trigger-schedule.executor.ts    # no-op, DAG-Start-Marker
│   ├── action-log.executor.ts
│   ├── action-todo-create.executor.ts
│   └── action-notify.executor.ts
└── (bestehend: schemas/, dto/, controller, service, module)
```

### Datenfluss

1. `WorkflowsService.startRun()` legt Run mit `status=QUEUED` an (bestehend) und emittet `workflow.run.queued`
2. `WorkflowQueueService.@OnEvent('workflow.run.queued')` lädt Run, sucht Trigger-Nodes im `definitionSnapshot`, erzeugt für jeden einen `WorkflowNodeRun(status=QUEUED)`, pusht NodeJob in In-Memory-Queue, setzt Run auf `RUNNING`
3. `WorkerPool` zieht NodeJobs (N=4 parallel, konfigurierbar), holt Definition-Lock, ruft `NodeRegistry.execute(type, ctx)`
4. Executor liefert `NodeResult` → Engine persistiert NodeRun, schreibt Output in `run.context.nodes[nodeId]`
5. `GraphWalker` ermittelt next-Nodes (filtert Edges nach branch/condition) → neue Jobs
6. Wenn keine offenen NodeRuns mehr existieren und alle Branches terminiert → Run `SUCCEEDED`

### Crash-Recovery

`WorkflowEngineService.onModuleInit()`:
- Runs mit `status=RUNNING` und `updatedAt < now-5min`: zugehörige NodeRuns `status=RUNNING` → `INTERRUPTED`, Run zurück auf `QUEUED`, neu eingereiht (oder `FAILED`, wenn keine Retry-Marge)
- Runs mit `status=QUEUED`: re-emit `workflow.run.queued`
- Runs `status=WAITING_FOR_USER`: bleiben (warten auf question-Event)

## Datenstrukturen

### WorkflowDefinition — neue Felder

```ts
nextRunAt?: Date         // vom Scheduler berechnet
lastRunAt?: Date         // letzter erfolgreich gestarteter Run
```

Neuer Index: `{ 'trigger.type': 1, status: 1, nextRunAt: 1 }`

### WorkflowRun — neue Felder

```ts
context: Record<string, unknown>     // shared state: nodes[nodeId] = output
triggeredBy?: {
  type: 'manual' | 'schedule' | 'event'
  scheduleSlotAt?: Date              // nominale Slot-Zeit (Idempotenz)
  userId?: string
}
```

Neuer Index (sparse, unique): `{ definitionId: 1, 'triggeredBy.scheduleSlotAt': 1 }` — verhindert Catch-up-Duplikate.

### WorkflowNodeRun — Erweiterungen

```ts
waitingFor?: {
  type: 'question'
  refId: ObjectId
}
```

- `logs[]` wird auf max. 200 Einträge gecappt (FIFO)
- Neuer Enum-Wert in `WorkflowNodeRunStatus`: `INTERRUPTED`

### Trigger-Config (typed via DTO/Zod, gespeichert in `trigger: Record<string,unknown>`)

```ts
{ type: 'manual' }
{ type: 'schedule', cron?: string, intervalMinutes?: number, timezone?: string, maxCatchUp?: number }
// reserviert: { type: 'event', eventName: string }
```

Validation: genau eines von `cron` oder `intervalMinutes` muss gesetzt sein, wenn `type=schedule`.

### Node-Config-Konventionen (kein Schema-Change)

```ts
retry?: { maxAttempts: number, backoffMs: number, backoffMultiplier?: number }  // Default maxAttempts=0
timeoutMs?: number                                                              // Default 30000
```

## Execution-Lifecycle

### Run-Start (manuell)

1. `startRun()` → Run `QUEUED`, Event `workflow.run.queued`
2. `WorkflowQueueService` lädt Run, sucht Trigger-Node(s), erzeugt NodeJobs
3. Run-Status `RUNNING`

### Worker-Loop

1. Worker zieht NodeJob aus Queue
2. **Definition-Lock**: In-Memory `Map<definitionId, Promise>` — wenn Lock vorhanden, Job re-enqueued (zwei Runs derselben Definition niemals parallel)
3. `NodeRegistry.get(nodeType)` — fehlend → NodeRun `failed`, Run `failed`
4. NodeRun `status=RUNNING`, `startedAt=now`
5. Executor via `Promise.race` gegen `timeoutMs`
6. Executor-Context:
   ```ts
   {
     run: WorkflowRun
     nodeRun: WorkflowNodeRun
     node: WorkflowNode
     config: Record<string, unknown>
     secretRefs: string[]
     runContext: Record<string, unknown>        // = run.context
     logger: { info, warn, error }              // schreibt in nodeRun.logs (capped)
     askUser: (prompt, choices?) => Promise<{ refId }>  // erzeugt question-Record und gibt refId zurück; Executor muss anschließend status='waiting' mit waitingFor.refId zurückgeben — askUser blockt NICHT auf die Antwort
     services: { todos, notifications, ... }    // DI für Mini-Nodes
   }
   ```

### Node-Result-Handling

`NodeResult`:
```ts
{ status: 'success' | 'failed' | 'waiting'
  output?: Record<string, unknown>
  error?: { code: string, message: string, details?: unknown }
  branch?: 'success' | 'failure' | 'custom'
  waitingFor?: { type: 'question', refId: ObjectId } }
```

- **success**: NodeRun gespeichert, Output → `run.context.nodes[nodeId]`, `GraphWalker.nextNodes(node, branch)` → neue Jobs
- **failed**:
  - Wenn `attempt < retry.maxAttempts`: neuer NodeRun mit `attempt+1` via `setTimeout(backoffMs * multiplier^attempt)`
  - Sonst Run `FAILED`, alle pending Jobs der Run-ID aus Queue gefiltert
- **waiting**: NodeRun `WAITING`, Run `WAITING_FOR_USER`, kein Folge-Job

Terminierung: kein offener Job mehr + alle Branches terminal → Run `SUCCEEDED`.

### Question-Resume

`WorkflowEngineService.@OnEvent('question.answered')`:
1. Suche NodeRun mit `waitingFor.refId = questionId`
2. Wenn nicht gefunden: ignorieren (Question gehört nicht zu Workflow)
3. Antwort in `nodeRun.outputSnapshot`, NodeRun `SUCCEEDED`
4. Behandle wie normales `success`-Result: next-Nodes triggern, Run `RUNNING`

### Scheduler-Tick

`SchedulerService.@Cron(EVERY_MINUTE)`:
1. Query: `{ status: ACTIVE, 'trigger.type': 'schedule', $or: [{ nextRunAt: { $lte: now }}, { nextRunAt: null }] }`
2. Pro Definition (in-memory Lock pro `definitionId`):
   - `computeMissedSlots(lastRunAt, now, trigger, maxCatchUp)` → Liste nominaler Slot-Zeiten
   - Für jeden Slot: `startRun({ triggeredBy: { type: 'schedule', scheduleSlotAt }})` — unique-Index fängt Duplikate ab
   - `nextRunAt = computeNext(trigger, now)`, `lastRunAt = now` persistiert
3. Library: `cron-parser` (Standard für Cron-Slot-Iteration in Node; falls noch keine Dependency, bei Implementierung hinzufügen)

`maxCatchUp` Default: 1. Bei Backend-Downtime über mehrere Slots werden nur die letzten `maxCatchUp` nachgeholt.

### Cancel / Replay

- `cancelRun()` (bestehend): zusätzlich pending NodeJobs der Run-ID aus Queue filtern
- Neu `retryRun(runId, fromNodeId?)`:
  - Nur erlaubt für Runs in `FAILED` oder `CANCELLED`
  - Pending NodeRuns löschen
  - Run-Status → `QUEUED`
  - NodeJob für `fromNodeId` (oder ersten failed Node) erzeugen, Event `workflow.run.queued`

## Mini-Node-Katalog (T-250)

### `trigger.manual`
- Executor: no-op, `status=success`, kein output
- Akzeptiert beliebigen `runContext.input` (vom Caller via `startRun({ input })`)

### `trigger.schedule`
- Executor: no-op, `status=success`
- `runContext.scheduleSlotAt = run.triggeredBy.scheduleSlotAt`

### `action.log`
- Config: `{ message: string, level?: 'info'|'warn'|'error' }`
- Executor: schreibt via `ctx.logger`, `status=success`

### `action.todo-create`
- Config: `{ title: string, description?, priority?, tags?, milestoneId?, projectId?, customerId? }`
- Template-Variable-Expansion: `{{context.nodes.someNode.outputField}}` per simplem `String.replace`-Pass über Run-Context
- Inferiert `projectId`/`customerId` aus Run-Scope, wenn nicht gesetzt
- Ruft `todosService.create()`
- Output: `{ todoId, todoNumber }`

### `action.notify`
- Config: `{ title: string, body?: string, channel?: 'webpush' }`
- Ruft bestehendes Notification-System (Web-Push)
- Output: `{ notificationId, recipientCount }`

## API/MCP-Ergänzungen

Erweiterung des bestehenden Controllers + `mcp-tools.ts`:

- `POST /api/workflows/runs/:id/retry` mit Body `{ fromNodeId? }` → `retryRun()`
- MCP: `workflow_run_retry`
- Optional `GET /api/workflows/engine/status` → `{ workersActive, queueDepth, definitionsLocked }` (Debug-Endpoint)

Unverändert: `workflow_run_start`, `workflow_run_cancel`, `workflow_run_list`, `workflow_run_get`, `workflow_node_run_list`.

## Konfiguration (.env)

```env
WORKFLOW_WORKER_CONCURRENCY=4
WORKFLOW_SCHEDULER_DISABLED=false       # true in Tests
WORKFLOW_RUN_RECOVERY_AGE_MS=300000     # 5 Minuten
WORKFLOW_NODE_LOG_CAP=200
```

## Test-Strategie

### Unit (Jest, `backend/src/workflows/**/*.spec.ts`)
- `graph-walker.spec.ts`: branch-Filterung (success/failure/always/custom), conditions, fan-out, fan-in
- `node-registry.spec.ts`: register/get, unknown-type wirft
- `workflow-scheduler.spec.ts`: `computeMissedSlots` (cron + interval), `maxCatchUp` Cap, `computeNext` mit Jest fake timers
- `workflow-engine.spec.ts`: Lifecycle (queued→running→succeeded), Retry-Backoff (fake timers), Definition-Lock (Serialisierung zweier Runs derselben Definition), Recovery markiert stale `RUNNING` als `INTERRUPTED`
- Pro Mini-Node ein Executor-Test

### E2E (`backend/test/workflows-runner.e2e-spec.ts`)
- Setup: Compose-MongoDB, NestJS-TestingModule, `WORKFLOW_SCHEDULER_DISABLED=true`, `WORKFLOW_WORKER_CONCURRENCY=1`
- Workflow `manual-trigger → todo-create → notify → log` anlegen, publizieren
- `startRun()`, poll auf `status=SUCCEEDED` (max 10s)
- Assertions:
  - Alle vier NodeRuns `succeeded`
  - Todo existiert in DB (`todosService.get(output.todoId)`)
  - Notification-Event emittiert (EventEmitter-Spy)
  - Letzter NodeRun hat Log-Eintrag mit erwarteter Message

### Lint + manuelle Verifikation
- `cd backend && npm run lint` muss grün sein
- Rebuild: `docker compose up -d --build backend`
- Smoke via MCP: `workflow_create` (manual-trigger → log), `workflow_run_start`, `workflow_run_get` → status `succeeded`
- Scheduler-Smoke: Workflow mit `intervalMinutes: 1` anlegen, 2 Minuten warten, `workflow_run_list` zeigt 2 Runs

## Akzeptanzkriterien (aus T-250) — Verifikations-Mapping

| Akzeptanz | Verifikation |
|---|---|
| Einfacher Workflow Trigger → Todo → Notification/Log läuft | E2E-Test + manueller MCP-Smoke |
| Run-Historie zeigt Status, Zeiten, Fehler, Node-Outputs | `workflow_run_get` + `workflow_node_run_list` liefern alle Felder; E2E-Assertions decken das ab |
| Fehler stoppen oder branchen kontrolliert, keine Endlosschleifen | Unit-Tests `workflow-engine.spec.ts` (Retry-Cap, fail-stops-run); GraphWalker hat kein Cycle-Detection im MVP, aber static `validateGraph` (T-249) lehnt self-loops ab; Loop-Limit als TODO für Cycle-Support |
| Scheduler respektiert active/paused und nächste Laufzeit | Unit-Tests `workflow-scheduler.spec.ts`; manueller Smoke mit `status=PAUSED` Definition |

## Offene Punkte für Folge-Tickets

- Echte Cycle-Erkennung / Loop-Limit (heute nur self-loop-Check) → T-252 (oder eigenes Ticket)
- Replay einzelner Nodes mit modifiziertem Input → T-254
- Worker-Pool über mehrere Backend-Instanzen koordinieren (heute: ein Backend, in-memory Lock) → später, evtl. Redis-Backed Queue
