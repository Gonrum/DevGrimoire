# React Flow Workflow Canvas UI (T-251)

Visueller Editor für Workflows im DevGrimoire-Frontend. Setzt auf der T-250-Engine und dem T-252-Node-Katalog auf — konsumiert `/api/workflows/node-types` als Datenquelle für Palette und Schema-Inspector.

Verwandte Dokumente:
- [Workflow Runner](workflow-runner.md) — Engine (T-250)
- [Workflow Nodes](workflow-nodes.md) — Node-Katalog + Metadata-System (T-252)
- [Workflow Run Observability](workflow-run-observability.md) — Replay-UI + Live-Run-Status (T-254, separat)
- [Workflows-Überblick](workflows.md)

## Scope

**In-scope (vollständiges Akzeptanz-MVP)**:
- 3-Panel-Layout (Palette / Canvas / Inspector) auf Desktop ≥ 1280px
- Tablet-Drawer-Pattern (768–1279px): Canvas full-width, Palette + Inspector als Slide-Drawer
- Phone-Read-only-Fallback (< 768px): JSON-View + Activate/Run-Buttons
- Custom-Node mit Kategorie-Akzentfarben (cyan/violet/amber/pink), Status-Ring, Lucide-Icon, Warn-Indikator, Node-Toolbar
- Custom-Edge mit Branch-Label, Connect-Validation (`isValidConnection`)
- Schema-driven Inspector — hand-gerollter rekursiver Renderer für JSON-Schema (string/enum/number/boolean/array/object/oneOf/record)
- Palette mit Search + Category-Collapsibles, drag-from-palette (Desktop) und tap-to-place (Touch)
- Save-Roundtrip mit Backend-Validation-Surface (Banner + inline Node-Warns)
- Activate-Flow mit implicit Save + Status-Transition
- Run-Trigger + Run-Inspector-Modal (polled NodeRuns, bis T-254 die volle Live-View liefert)
- Top-Level-Route `/workflows` (Liste mit Filter) und in-Page-Tabs in ProjectDetail + CustomerDetail
- Template-Hint-Picker für `{{nodes.*}}` und `{{input.event.*}}` Pfade
- Mobile-Breite Detection mit Fallback-View

**Out-of-scope (Folge-Tickets)**:
- Live-Run-Visualization auf Canvas (Status-Animation während Runs, SSE-Stream-Anbindung) → T-251a oder T-254-Erweiterung
- Workflow-Diff / Versionshistorie-Viewer → T-251c
- Subflows / Group-Nodes → T-251d
- Polished Mobile-Editor → T-251e
- Templates-Wizard aus dem Canvas → integriert mit T-253
- Multi-Select / Lasso / Bulk-Edit → T-251f
- Autocomplete-Picker mit Typ-Inferenz + Vorschau-Werten aus letztem Run → T-251b

## Architektur

**Neue Files** unter `frontend/src/`:

```
frontend/src/
├── pages/
│   ├── WorkflowsListPage.tsx       # /workflows
│   └── WorkflowEditorPage.tsx      # /workflows/:id
├── components/workflows/
│   ├── WorkflowCanvas.tsx          # ReactFlow-Wrapper, Drop-Handler, isValidConnection
│   ├── WorkflowNodePalette.tsx     # Links/Drawer: Search + Category-Listen
│   ├── WorkflowNodeInspector.tsx   # Rechts/Drawer: schema-Form + meta-info
│   ├── WorkflowCustomNode.tsx      # ReactFlow-Custom-Node: Header, Icon, Status, Branches
│   ├── WorkflowCustomEdge.tsx      # ReactFlow-Custom-Edge: Branch-Label + Delete
│   ├── WorkflowValidationBanner.tsx # Sticky-Banner unten, parsed remote + local issues
│   ├── WorkflowRunInspector.tsx    # Modal: Run-Header + NodeRuns-Tabelle + Detail-Panel
│   ├── WorkflowProjectTab.tsx      # Wieder-verwendbar für ProjectDetail/CustomerDetail
│   ├── SchemaField.tsx             # Rekursiver JSON-Schema-Renderer
│   ├── TemplatePicker.tsx          # Popover-Picker für {{...}}-Pfade
│   ├── nodeTypeIconMap.ts          # type→Lucide-Icon Mapping
│   └── nodeCategoryStyles.ts       # category→{borderColor, headerBg, dotColor}
├── hooks/
│   ├── useNodeTypesCatalog.ts      # In-memory cached + 60s revalidate
│   ├── useViewportBreakpoint.ts    # 'phone'|'tablet'|'desktop' Hook
│   └── useWorkflowDirtyGuard.ts    # beforeunload-Warning bei unsaved changes
└── api/
    └── workflows.ts                # Typed client wrapper
```

**Modifizierte Files**:
- `frontend/src/App.tsx` (oder Routes-Datei) — neue Routes `/workflows`, `/workflows/:id`
- `frontend/src/components/Sidebar.tsx` (oder gleichwertig) — neuer Eintrag "Workflows"
- `frontend/src/pages/ProjectDetail.tsx` — neuer Tab "Workflows" (rendert `WorkflowProjectTab`)
- `frontend/src/pages/CustomerDetail.tsx` — analog
- `frontend/src/api/client.ts` — `workflowsApi` Section
- `frontend/src/locales/de.json` und `en.json` — neue Translation-Keys (`workflows.*`)
- `frontend/package.json` — neue Deps: `@xyflow/react`

**Keine Backend-Änderungen** — alle benötigten Endpoints existieren aus T-252.

## Library und Theming

**React Flow**: `@xyflow/react@^12` (neuer Org-Name xyflow, MIT, aktiv gepflegt). CSS-Import: `@xyflow/react/dist/style.css`. Background-Pattern: dots oder grid.

**Lucide-Icons**: bereits Frontend-Dep. Kein neuer Install.

**Kategorie-Akzente** (TailwindCSS Klassen):

| Kategorie | Border | Header-BG | Dot-Color |
|---|---|---|---|
| trigger | `border-cyan-600` | `bg-cyan-900/40` | `bg-cyan-400` |
| action | `border-violet-600` | `bg-violet-900/40` | `bg-violet-400` |
| control | `border-amber-600` | `bg-amber-900/40` | `bg-amber-400` |
| agent | `border-pink-600` | `bg-pink-900/40` | `bg-pink-400` |

**Status-Ring** (animiert via Tailwind):
- idle → kein Ring
- queued → `ring-2 ring-gray-400`
- running → `ring-2 ring-yellow-400 animate-pulse`
- succeeded → `ring-2 ring-green-500`
- failed → `ring-2 ring-red-500`
- waiting → `ring-2 ring-violet-400 animate-pulse`
- interrupted → `ring-2 ring-amber-500`

**Node-Type-Icon-Mapping** (`nodeTypeIconMap.ts`, fallback `Circle`):
```ts
{
  'trigger.manual':            Hand,
  'trigger.schedule':          Clock,
  'trigger.project_event':     Activity,
  'trigger.customer_event':    Users,
  'action.log':                FileText,
  'action.todo-create':        SquarePlus,
  'action.todo-update':        Edit,
  'action.todo-comment':       MessageSquare,
  'action.todo-link-milestone': Link,
  'action.knowledge-create':   BookOpen,
  'action.manual-create':      FileEdit,
  'action.changelog-add':      History,
  'action.notify':             Bell,
  'action.user-question':      HelpCircle,
  'control.condition':         GitBranch,
  'control.delay':             Clock,
  'agent.task':                Sparkles,
}
```

## Routen + Navigation

**Top-Level-Route `/workflows`** (`WorkflowsListPage`):
- Sidebar-Eintrag mit Lucide `Workflow`-Icon, zwischen "Recurring Tasks" und einem passenden Punkt
- Filter-Bar oben: scope-Select (all/system/project/customer), status-Pills (multi-select draft/active/paused/archived), Tag-Input
- Card-Grid (responsiv: 1 Spalte mobile, 2 tablet, 3 desktop): pro Workflow Name, Scope-Badge, Status-Pill, Trigger-Type-Icon, last-run-Status (klein, sekundär)
- Pro Card: Click → `/workflows/:id` (Editor); Kontext-Menü ⋯ mit Pause/Activate/Archive/Delete/Duplicate/Run
- CTA oben rechts: "Neuer Workflow" → kleiner Modal-Wizard (Name, Scope, projectId/customerId Select, trigger.type) → `workflowsApi.create({ ..., nodes: [{trigger}], edges: [] })` → redirect

**Top-Level-Route `/workflows/:id`** (`WorkflowEditorPage`):
- Header (sticky top): Breadcrumb `← Workflows / <Name>`, Status-Pill, Version-Pill, Scope-Pill, Save-Button, Activate-Button, Run-Button, ⋯-Menü (Pause/Resume/Archive/Delete/Duplicate)
- 3-Panel-Layout per Viewport (siehe nächster Abschnitt)
- Footer (sticky bottom, nur sichtbar wenn Issues): WorkflowValidationBanner

**ProjectDetail / CustomerDetail Tab**:
- Neuer Tab "Workflows" rendert `WorkflowProjectTab` mit `scope=project, projectId=<...>` Filter
- Innerhalb des Tabs: gleiche Card-Grid wie ListPage, gefiltert; CTA "+ Neuer Workflow" pre-fills scope/projectId
- Click auf Card → `/workflows/:id` (Top-Level-Editor)

## Viewport-Breakpoints + Layout

`useViewportBreakpoint()` Hook liefert `'phone'|'tablet'|'desktop'`:

| Viewport | Breite | Layout |
|---|---|---|
| desktop | ≥ 1280px | Feste 3-Panels nebeneinander: Palette 260px / Canvas flex-1 / Inspector 320px |
| tablet | 768–1279px | Canvas full-width; Palette + Inspector als Slide-In-Drawer (translate-x animiert). Trigger über zwei sticky 56px-Icon-Buttons am Bildschirmrand (`PanelLeftOpen` / `PanelRightOpen`). Inspector öffnet automatisch wenn ein Node selektiert wird. |
| phone | < 768px | Read-only Fallback-Card mit Workflow-JSON, Activate-/Run-Buttons. Header zeigt Warn "Editor benötigt ≥ 768px Breite". |

**Touch-Optimierungen**:
- Palette-Items per Tap-to-place statt Drag (Tap auf Item → "Tap auf Canvas-Position um zu platzieren" Mode bis nächster Canvas-Tap)
- Edge-Branch-Selektor per Tap auf Edge → Bottom-Sheet (statt Hover-Menü)
- Alle Buttons + Form-Inputs min 44px Hit-Area

## Custom-Node-Komponente

`WorkflowCustomNode.tsx` rendert pro `WorkflowNode`:

```
┌──────────────────────────────────┐ ← border-{cat}-600, bg-gray-900, rounded-lg
│ ● [Icon] action.todo-create  ⚠  │ ← Header: status-dot + lucide-icon + type + warn
│         id: todo                 │
│         "Todo anlegen"           │ ← metadata.label
├──────────────────────────────────┤
│ ▼ branches                       │
│    success ──○                   │ ← React-Flow Handle type=source, id=success
│    failure ──○                   │ ← falls metadata.branches enthält failure
└──────────────────────────────────┘
   ↑ Handle type=target (außer Trigger-Kategorie)
```

**Visuelle Details**:
- Selected: `ring-2 ring-cyan-400` (override über Status-Ring wenn beides aktiv)
- Status-Dot oben links, 8px, Animation per Tailwind `animate-pulse`
- Warn-Indikator oben rechts (lucide AlertTriangle, amber): nur wenn `localValidationIssues.length > 0` OR `remoteIssues` für diesen `node.id`. Tooltip mit Issue-Liste
- Lucide-Icon links neben dem Type: 16px, Farbe matched Status-Dot wenn idle/queued, sonst weiß
- Node-Toolbar (ReactFlow `NodeToolbar position="top"`, sichtbar wenn selected): Duplicate (`Copy`) und Delete (`Trash2`) Buttons
- Min-Width 220px, Auto-Height

**Live-Validation pro Node** (in `useMemo` über `node.data.config` + `metadata.configSchema`):
- Parsed mit `ajv` (neue Dep) ODER hand-gerollten Validator gegen das JSON-Schema (rekursiv: required, type, enum, min/max)
- Entscheidung: ajv — schon ein common JS-Schema-Validator, ~30KB, deutlich kürzerer Code-Pfad als hand-gerollt
- Issues werden im Inspector als Liste angezeigt; Warn-Indikator im Node-Header zeigt nur Count

## Custom-Edge-Komponente

`WorkflowCustomEdge.tsx` rendert eine Edge mit:
- Standard-Bezier-Path (ReactFlow default)
- Mid-Point-Pill mit `branch`-Label, gefärbt nach branch (success=green, failure=red, custom=violet); `'always'` → kein Label
- Hover-State (Desktop): Delete-Button `lucide X` erscheint am Mid-Point
- Selected-State: dicker stroke + farbige outline matching branch
- Click auf Edge → setSelectedEdge → Inspector zeigt Branch-Switcher + Condition-Editor
- Tap auf Edge (Touch): öffnet Bottom-Sheet mit "Branch ändern" + "Löschen"
- Edge mit `condition`-Objekt: zusätzliches Filter-Icon links der Pill, Tooltip zeigt Condition-JSON

**Connect-Validation** (`isValidConnection` Prop am ReactFlow):
```ts
function isValidConnection(conn: Connection): boolean {
  if (conn.source === conn.target) return false;
  const targetNode = nodes.find((n) => n.id === conn.target);
  if (targetNode?.data.type?.startsWith('trigger.')) return false;
  const duplicate = edges.some(
    (e) =>
      e.source === conn.source &&
      e.target === conn.target &&
      e.sourceHandle === conn.sourceHandle,
  );
  if (duplicate) return false;
  return true;
}
```
ReactFlow zeigt die Connect-Linie automatisch rot, solange invalid.

## Validation-Banner

`WorkflowValidationBanner.tsx` — sticky bottom, gradient `from-amber-900/40 to-red-900/40 border-amber-700`:
- Compact: `⚠ {n} Validierungsfehler  [details ▾]`
- Expanded: Liste der Issues. Pro Issue:
  - Wenn `nodeId` bekannt: Chip mit Node-ID + Type + Message; Click setzt Selection auf Node und `reactFlow.setCenter(node.position)`
  - Wenn nicht zuordbar: Plain-Text mit `rawMessage`
- Sources:
  - **Lokal** (Live, in-memory): aus `useMemo` über alle Nodes/Edges (config-schema-issues, dangling edges, self-loops, duplicate-node-ids)
  - **Remote** (nach Save-Versuch): parsed aus BadRequestException-Message; bleibt sichtbar bis nächster erfolgreicher Save

**Issue-Parser** (`parseValidationIssues(msg: string): RemoteIssue[]`):
```ts
function parseValidationIssues(msg: string): RemoteIssue[] {
  return msg.split(/;\s*/).map((line) => {
    const m = line.match(/node "(?<id>[^"]+)"(?:\s*\((?<type>[^)]+)\))?\s*(?<rest>.+)/);
    if (!m?.groups) return { rawMessage: line };
    return {
      nodeId: m.groups.id,
      nodeType: m.groups.type,
      message: m.groups.rest,
    };
  });
}
```

## Schema-driven Inspector

`SchemaField.tsx` — rekursiver JSON-Schema-Renderer.

**Props**:
```ts
interface SchemaFieldProps {
  schema: JsonSchemaNode;
  path: (string | number)[];
  value: unknown;
  onChange: (newValue: unknown) => void;
  required?: boolean;
  templateContext?: TemplateContext;  // optional, für {{}}-Picker
}
```

**Type-Switch**:
- `string` + `enum`: native `<select>` mit Tailwind dark-styling
- `string` + `format: 'date-time'`: `<input type="datetime-local">`
- `string` ohne enum:
  - Wenn key matcht `/^(prompt|description|content|message|body|title|text)$/`: `<textarea>` (auto-grow, min-rows 3)
  - sonst: `<input type="text">`
  - Beide bekommen den `{{}}` Template-Picker-Trigger rechts
- `number`/`integer`: `<input type="number">` mit min/max/step aus schema constraints
- `boolean`: Toggle-Switch (rounded-full + animated thumb)
- `array`:
  - `items.type === 'string'`: Tag-Input (Komma/Enter trennt; Pills mit ×)
  - sonst: Liste mit "+ hinzufügen", jedes Item rekursiv `SchemaField`, mit Move-Up/Move-Down/Delete
- `object`: `<fieldset>` mit border, jeder property eigener `SchemaField`
- `oneOf`/`anyOf`: Tab-Switcher zwischen Varianten, preserve-state pro Tab
- `record` (z.B. `branchMap`): Listen-Pattern mit zwei Inputs pro Eintrag (key + value)
- Fallback `unknown`/Schema-not-matched: JSON-Textarea mit Live-Parse-Validation

**Template-Picker** (`TemplatePicker.tsx`):
- Popover ankert am `{{}}` Icon-Button
- Listet:
  - `{{input.event.entityId}}`, `{{input.event.entity}}`, `{{input.event.action}}`, etc. (wenn Trigger ein Event ist)
  - Pro vorgelagertem Node (DAG-walk rückwärts von selectedNode): `{{nodes.<id>.<outputKey>}}` aus `metadata.outputs`
- Click auf Eintrag fügt den Pfad an Cursor-Position ein

## Inspector-Layout

```
┌─ Inspector ────────────────────┐
│ Node ID: [todo___________]  ⋯  │
│                                │
│ Type: action.todo-create  [↔]  │ ← Type-Switcher button öffnet Picker (resetted config!)
│ Todo anlegen                   │
│ "Erzeugt ein neues Todo..."    │
│                                │
│ ─── Konfiguration ─────────────│
│ Title*                         │
│ [_____________________] {{}}   │
│                                │
│ Description                    │
│ [_______________________]      │
│                                │
│ Priority                       │
│ [Medium ▾]                     │
│                                │
│ Tags                           │
│ [tag1] [tag2] [+]              │
│                                │
│ ─── Outputs (read-only) ───────│
│ • todoId: string               │
│ • todoNumber: string|null      │
│                                │
│ ─── Branches ──────────────────│
│ ○ success (2 outgoing)         │
│ ○ failure (0 outgoing)         │
│                                │
│ ─── ⚠ Validierung ─────────────│
│ config.title: required         │
│                                │
│ [Duplizieren] [Löschen]        │
└────────────────────────────────┘
```

**Type-Switcher**: Click öffnet einen Picker (gleich wie Palette-Filter), nach Wahl wird `node.data.type` ersetzt UND `node.data.config = getDefaultsFromSchema(newMetadata.configSchema)`. Warnung: "Konfiguration wird zurückgesetzt".

**Wenn kein Node selektiert**: Empty-State mit Hint "Tippe einen Node an oder ziehe einen aus der Palette."

**Wenn Edge selektiert**: zeigt source→target, Branch-Select (Pills für `success`/`failure`/`custom`/`always`), Condition-Editor (JSON-Textarea mit Beispiel-Comment).

## Palette

```
┌─ Palette ──────────────┐
│ 🔍 [search...]         │
│                        │
│ ▾ Trigger          (4) │
│   ⚡ Manuell           │
│   ⏰ Schedule          │
│   📡 Project-Event     │
│   👥 Customer-Event    │
│                        │
│ ▾ Action          (9)  │
│   📝 Log              │
│   ✓ Todo anlegen      │
│   ↻ Todo updaten      │
│   💬 Todo-Kommentar    │
│   🏷️ Milestone-Link    │
│   📖 Knowledge         │
│   📄 Manual            │
│   📋 Changelog         │
│   🔔 Notify            │
│   ❓ User-Question     │
│                        │
│ ▾ Control         (2)  │
│   ⑂ Condition         │
│   ⏱ Delay             │
│                        │
│ ▾ Agent           (1)  │
│   ✨ Agent-Task        │
└────────────────────────┘
```

**Verhalten**:
- Suche filtert Live nach `label` ODER `type` (case-insensitive)
- Categories collapsible (expanded-state in localStorage gepinnt)
- Desktop: Items sind `draggable` (HTML5 drag-API); Drop in ReactFlow-Pane platziert Node an Drop-Position
- Tablet/Touch: Tap auf Item aktiviert "Platzier-Mode" mit toast-Hint, nächster Canvas-Tap erzeugt Node dort
- Items deaktiviert (grayed-out + Tooltip) wenn `metadata.allowedScopes` den aktuellen Workflow-Scope nicht enthält. Beispiel: `action.changelog-add` ist nur project — bei customer-Workflow grayed-out

**Auto-ID-Generierung** beim Drop:
```ts
function generateNodeId(type: string, existingIds: string[]): string {
  const prefix = type.split('.').pop() ?? 'node';   // 'trigger.manual' → 'manual'
  let counter = 1;
  let candidate = prefix;
  while (existingIds.includes(candidate)) {
    counter++;
    candidate = `${prefix}_${counter}`;
  }
  return candidate;
}
```

**Default-Config** aus zod-Schema-Defaults (wo das Schema sie exportiert; sonst leeres Objekt):
```ts
function getDefaultsFromJsonSchema(schema: JsonSchemaNode): unknown {
  if (schema.default !== undefined) return schema.default;
  if (schema.type === 'object' && schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (schema.required?.includes(k)) out[k] = getDefaultsFromJsonSchema(sub as JsonSchemaNode);
    }
    return out;
  }
  if (schema.type === 'array') return [];
  if (schema.type === 'string') return '';
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'boolean') return false;
  return undefined;
}
```

## API-Client

`frontend/src/api/workflows.ts`:

```ts
export interface WorkflowNodeMetadata {
  type: string;
  category: 'trigger' | 'action' | 'control' | 'agent';
  label: string;
  description: string;
  allowedScopes: WorkflowScope[];
  configJsonSchema: Record<string, unknown>;
  outputs: Record<string, string>;
  branches: ('success' | 'failure' | 'custom')[];
}

export const workflowsApi = {
  listNodeTypes: () => apiClient.get<WorkflowNodeMetadata[]>('/workflows/node-types'),

  list: (filter: ListFilter) => apiClient.get<WorkflowDefinition[]>('/workflows', filter),
  get: (id: string) => apiClient.get<WorkflowDefinition>(`/workflows/${id}`),
  create: (dto: CreateWorkflowDto) => apiClient.post<WorkflowDefinition>('/workflows', dto),
  update: (id: string, dto: UpdateWorkflowDto) => apiClient.put<WorkflowDefinition>(`/workflows/${id}`, dto),
  delete: (id: string) => apiClient.delete(`/workflows/${id}`),

  start: (definitionId: string, input?: Record<string, unknown>) =>
    apiClient.post<WorkflowRun>('/workflows/runs', { definitionId, input }),
  listRuns: (filter: RunFilter) => apiClient.get<WorkflowRun[]>('/workflows/runs/list', filter),
  getRun: (id: string) => apiClient.get<WorkflowRun>(`/workflows/runs/${id}`),
  cancelRun: (id: string, reason?: string) => apiClient.post(`/workflows/runs/${id}/cancel`, { reason }),
  retryRun: (id: string, fromNodeId?: string) =>
    apiClient.post(`/workflows/runs/${id}/retry`, { fromNodeId }),
  listNodeRuns: (runId: string) =>
    apiClient.get<WorkflowNodeRun[]>(`/workflows/runs/${runId}/node-runs`),
};
```

## Save / Activate / Run

**Save-Flow**:
1. Map ReactFlow-State → Backend-DTO (`{ nodes: [...], edges: [...], trigger, ui }`)
2. `workflowsApi.update(id, dto)` PUT
3. Success: `setRemoteIssues([])`, version-bump-Hint wenn `updated.version !== currentVersion`, success-Toast
4. BadRequest (400): `parseValidationIssues(err.message)` → `setRemoteIssues(issues)`, error-Toast, Banner expandiert sich

**Activate-Flow**:
1. Implicit Save first (gleicher Code-Pfad)
2. Wenn Save failed (`remoteIssues.length > 0`): abort
3. PUT mit `{ status: 'active' }`
4. Backend macht: `validateGraph` + `workflowSecurityIssues` + zod-schemaValidation pro Node — wenn eines failt → 400 mit Issues-String
5. Erfolgreich: `setStatus('active')`, success-Toast

**Run-Flow**:
1. POST `/workflows/runs` mit `{ definitionId }`
2. Erfolgreich: Toast mit Run-ID + Modal-Trigger
3. `WorkflowRunInspector` Modal öffnet, polled `getRun` + `listNodeRuns` alle 1s solange non-terminal (max 5min, dann stop-polling)

## Run-Inspector-Modal

`WorkflowRunInspector.tsx`:
- Header: Run-ID, Status-Pill, startedAt, finishedAt, triggeredBy
- Body: Tabelle der NodeRuns (gerendert in Reihenfolge createdAt)
  - Columns: nodeId, type, status, attempt, durationMs (formatted), Click → Detail-Panel
- Detail-Panel (klappt rechts auf): outputSnapshot (collapsible JSON), logs[] (Listen-View), error (wenn vorhanden, rot-coded)
- Footer-Buttons:
  - "Cancel" wenn status non-terminal (`queued|running|waiting_for_*`)
  - "Retry" wenn status `failed|cancelled`
  - "Schließen"
- Poll-Intervall: 1s wenn non-terminal, sonst stop
- Falls Backend kein Run mehr findet (404): zeige "Run nicht gefunden" + Modal-Close

## ProjectDetail / CustomerDetail Tab

`WorkflowProjectTab.tsx`:
```tsx
function WorkflowProjectTab({ scope, projectId, customerId }: Props) {
  return (
    <div>
      <Header
        title="Workflows"
        actions={[<CreateButton scope={scope} projectId={projectId} customerId={customerId} />]}
      />
      <CardGrid workflows={filtered} onClick={(id) => navigate(`/workflows/${id}`)} />
    </div>
  );
}
```

Eingebunden in ProjectDetail/CustomerDetail wie die anderen Tabs (Todos, Knowledge, etc.) — folgt dem bestehenden Pattern.

## Sidebar-Navigation

`Sidebar.tsx` bekommt einen neuen Eintrag im Workflow-Bereich:
- Label: "Workflows"
- Icon: `lucide Workflow`
- Route: `/workflows`
- Position: zwischen "Recurring Tasks" und "Customer Templates" (Workflow-Cluster)

## i18n-Keys

Neue Keys unter `workflows.*` in `frontend/src/locales/de.json` und `en.json`:
- `workflows.title`: "Workflows" / "Workflows"
- `workflows.new`: "Neuer Workflow" / "New Workflow"
- `workflows.empty`: "Noch keine Workflows" / "No workflows yet"
- `workflows.status.draft/active/paused/archived`: pro Status
- `workflows.actions.save/activate/run/pause/resume/archive/delete/duplicate`
- `workflows.editor.palette/inspector/validation/savedAt/version`
- `workflows.editor.mobileWarning`: "Editor benötigt ≥ 768px Breite" / "Editor requires ≥ 768px width"
- `workflows.run.status.*`: pro Run-Status
- `workflows.run.cancel/retry/close`
- `workflows.create.wizard.name/scope/trigger`

## Verifikation

**Frontend hat kein Jest-Setup** — Verifikation per `npm run build` (tsc + Vite bundle, exit 0) plus manuelles Smoke-Testing im Browser.

**Bundle-Smoke**:
```bash
cd frontend && npm run build
# Suche nach kritischen Strings im gebundelten Output:
grep -ro "@xyflow/react\|workflow-node-types\|WorkflowCanvas\|control.delay\|action.user-question" dist/ | wc -l
# Expected: > 0
```

**Manuelle Akzeptanz-Smokes** (per Browser, gegen laufenden Backend):

| Akzeptanz | Smoke-Test |
|---|---|
| Nodes hinzufügen | Workflow öffnen, Item aus Palette droppen → Node erscheint auf Canvas an Drop-Position |
| Nodes verbinden | Drag von Output-Handle zu Input-Handle → Edge erscheint mit Branch-Label |
| Nodes verschieben | Drag eines Nodes → Position aktualisiert sich; Save → Backend hat neue position |
| Nodes konfigurieren | Click Node → Inspector öffnet; Field ändern → Status-Dot grau (idle) bleibt; Save → Backend hat neue config |
| Speichern | Save-Button → Toast "Workflow gespeichert"; Reload → State persistent |
| DevGrimoire-Look | Side-by-side Vergleich mit ProjectDetail: dark theme, gleiche Schriftgrößen, Border-Stil, Pill-Stil |
| Mobile-Fallback | DevTools auf 360px → JSON-View statt Editor sichtbar |
| Tablet-Drawer | DevTools auf 1024px → Canvas full-width, Palette-Drawer-Button erscheint |
| Validation-Fehler | Workflow ohne Trigger → Save → Banner zeigt "No trigger node in graph"; Click jump-to-node |
| Run-Trigger | Activate + Run → Modal öffnet, Status pollt, terminiert succeeded |

**Backend-Regression** (sicherheitshalber):
```bash
cd backend && npm run check:workflow-runner-units && npm run check:workflow-nodes-units
# Beide müssen weiterhin grün sein — T-251 ändert Backend nicht
```

## Akzeptanzkriterien — Verifikations-Mapping

| Akzeptanz (T-251) | Verifikation |
|---|---|
| User kann Nodes hinzufügen, verbinden, verschieben, konfigurieren und speichern | Vollständige Editor-Komponenten + Save-Roundtrip |
| Canvas sieht sichtbar nach DevGrimoire aus | Kategorie-Akzente cyan/violet/amber/pink, Tailwind dark-theme, WorkflowShell-Konsistenz |
| Mobile/kleine Breite bekommt lesbare Fallback-Ansicht | Phone-Read-only JSON-View (< 768px), Tablet-Drawer (768-1279px), Desktop-3-Panel (≥ 1280px) |
| Validierungsfehler sind direkt im Editor sichtbar | Lokale schema-Issues pro Node (Warn-Indikator + Inspector-Liste), Remote-Issues nach Save als Banner mit jump-to-node, Edge-Connect-Validation in Echtzeit |

## Konfiguration

Keine neuen Backend-Env-Vars. Frontend nutzt bestehende `VITE_API_URL` (oder gleichwertig). Setting `WORKFLOWS_CANVAS_ENABLED` als Feature-Flag in Settings ist YAGNI für MVP.

## Out-of-Scope-Folge-Tickets (zum Anlegen nach T-251 abgeschlossen)

1. **T-251a Live-Run-Visualization auf Canvas**: Status-Animation pro Node während aktiver Runs, via PROJECT_CHANGED-SSE-Stream
2. **T-251b Inline-Template-Picker UX**: Autocomplete mit Typ-Inferenz + Vorschau-Werten aus letztem Run-Context
3. **T-251c Workflow-Diff / Versionshistorie-Viewer**: Zwei Versionen visuell vergleichen
4. **T-251d Subflows / Group-Nodes**: ReactFlow-natives Pattern für lange Workflows
5. **T-251e Polished Mobile-Editor**: Linear-Listen-Editor für < 768px statt JSON-Fallback
6. **T-251f Multi-Select / Bulk-Edit**: Lasso-Select + bulk-rename/delete/move
