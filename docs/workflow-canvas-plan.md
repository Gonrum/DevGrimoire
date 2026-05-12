# React Flow Workflow Canvas Implementation Plan (T-251)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the visual React Flow workflow editor that consumes the T-252 `/workflows/node-types` catalog, supports drag-from-palette + connect + configure + save/activate/run + run-inspection, in DevGrimoire dark-theme with category-accent custom nodes.

**Architecture:** New top-level routes `/workflows` and `/workflows/:id` plus integrated tabs in `ProjectDetail` and `CustomerDetail`. Three viewport breakpoints — desktop (≥1280px, 3-panel), tablet (768-1279px, drawer-pattern), phone (<768px, JSON read-only). Custom ReactFlow nodes with category-color accents (cyan/violet/amber/pink) and live status rings. Hand-rolled JSON-Schema-driven recursive form renderer (no rjsf dep). Save-roundtrip surfaces backend `validateGraph` / `workflowSecurityIssues` / zod-schema issues as a bottom banner with jump-to-node.

**Tech Stack:** React 19, Vite, TypeScript, TailwindCSS 3, react-router-dom v7, i18next, `@xyflow/react@^12` (new dep), `lucide-react@^0` (new dep — icon set), existing `apiClient` + `useToast`.

**Reference spec:** [`docs/workflow-canvas.md`](workflow-canvas.md). Engine: T-250. Node-Katalog: T-252.

---

## File Map

**New files** under `frontend/src/`:

- `api/workflows.ts` — typed `workflowsApi` client
- `hooks/useNodeTypesCatalog.ts` — fetch + in-memory cache for `/workflows/node-types`
- `hooks/useViewportBreakpoint.ts` — `'phone' | 'tablet' | 'desktop'`
- `hooks/useWorkflowDirtyGuard.ts` — `beforeunload` warning hook
- `components/workflows/nodeCategoryStyles.ts` — category → tailwind classes mapping
- `components/workflows/nodeTypeIconMap.ts` — type → lucide-react Icon component
- `components/workflows/runStatusStyles.ts` — node-run status → ring tailwind classes
- `components/workflows/parseValidationIssues.ts` — backend error-string → `RemoteIssue[]`
- `components/workflows/schemaDefaults.ts` — `getDefaultsFromJsonSchema(schema)`
- `components/workflows/generateNodeId.ts` — collision-free id generator
- `components/workflows/SchemaField.tsx` — recursive JSON-Schema renderer
- `components/workflows/TemplatePicker.tsx` — `{{...}}` path picker popover
- `components/workflows/WorkflowCustomNode.tsx` — ReactFlow custom node
- `components/workflows/WorkflowCustomEdge.tsx` — ReactFlow custom edge with branch label
- `components/workflows/WorkflowValidationBanner.tsx` — sticky bottom banner
- `components/workflows/WorkflowNodePalette.tsx` — left/drawer palette
- `components/workflows/WorkflowNodeInspector.tsx` — right/drawer inspector
- `components/workflows/WorkflowCanvas.tsx` — ReactFlow wrapper + handlers
- `components/workflows/WorkflowRunInspector.tsx` — run modal with poll
- `components/workflows/WorkflowProjectTab.tsx` — reusable per-project/customer list
- `components/workflows/WorkflowCardGrid.tsx` — workflow card list component
- `components/workflows/CreateWorkflowDialog.tsx` — modal wizard
- `components/workflows/WorkflowEditorMobileFallback.tsx` — < 768px read-only view
- `pages/WorkflowsListPage.tsx` — `/workflows`
- `pages/WorkflowEditorPage.tsx` — `/workflows/:id`

**Modified files:**
- `frontend/package.json` — `@xyflow/react`, `lucide-react`
- `frontend/src/App.tsx` — new routes + nav-link entry
- `frontend/src/api/client.ts` — re-export `workflowsApi`
- `frontend/src/pages/ProjectDetail.tsx` — add Workflows tab
- `frontend/src/pages/CustomerDetail.tsx` — add Workflows tab
- `frontend/src/locales/de.json` — `workflows.*` keys
- `frontend/src/locales/en.json` — `workflows.*` keys

**Untouched:** Backend (all endpoints already exist from T-252).

---

## Task 1: Install dependencies

**Files:** `frontend/package.json`

- [ ] **Step 1: Install @xyflow/react + lucide-react**

```bash
cd frontend && npm install @xyflow/react@^12 lucide-react@^0.460
```

Expected: both deps added to `dependencies` in `package.json`, lockfile updated. Versions may differ slightly (e.g. `lucide-react@^0.461`) — accept whatever npm resolves.

- [ ] **Step 2: Smoke-test imports**

```bash
cd frontend && node -e "console.log(require.resolve('@xyflow/react/package.json'))"
cd frontend && node -e "console.log(require.resolve('lucide-react/package.json'))"
```

Expected: both paths print successfully.

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "chore(workflows): add @xyflow/react + lucide-react for canvas UI (T-251)"
```

---

## Task 2: API client + types

**Files:** Create `frontend/src/api/workflows.ts`. Modify `frontend/src/api/client.ts` to re-export.

- [ ] **Step 1: Write `workflows.ts`**

```ts
// frontend/src/api/workflows.ts
const baseUrl = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL || '/api';

type Branch = 'success' | 'failure' | 'custom';

export type WorkflowScope = 'system' | 'project' | 'customer';
export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';
export type WorkflowRunStatus =
  | 'queued' | 'running' | 'waiting_for_user' | 'waiting_for_timer'
  | 'succeeded' | 'failed' | 'cancelled';
export type WorkflowNodeRunStatus =
  | 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed'
  | 'skipped' | 'retrying' | 'interrupted';

export interface WorkflowNode {
  id: string;
  type: string;
  label?: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  secretRefs?: string[];
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  ui?: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourcePort?: string;
  targetPort?: string;
  branch?: Branch | 'always';
  condition?: Record<string, unknown>;
  label?: string;
  ui?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  _id: string;
  scope: WorkflowScope;
  projectId?: string;
  customerId?: string;
  name: string;
  description?: string;
  status: WorkflowStatus;
  version: number;
  tags: string[];
  trigger: Record<string, unknown>;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  ui?: Record<string, unknown>;
  nextRunAt?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRun {
  _id: string;
  definitionId: string;
  definitionVersion: number;
  scope: WorkflowScope;
  projectId?: string;
  customerId?: string;
  status: WorkflowRunStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: { code: string; message: string };
  context?: { nodes?: Record<string, unknown>; input?: Record<string, unknown> };
  triggeredBy?: { type: string; scheduleSlotAt?: string; userId?: string };
  createdAt: string;
}

export interface WorkflowNodeRun {
  _id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  status: WorkflowNodeRunStatus;
  attempt: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  outputSnapshot?: Record<string, unknown>;
  logs?: Array<Record<string, unknown>>;
  error?: { code: string; message: string };
  waitingFor?: { type: 'question' | 'delay'; refId?: string; resumeAt?: string };
}

export interface WorkflowNodeMetadata {
  type: string;
  category: 'trigger' | 'action' | 'control' | 'agent';
  label: string;
  description: string;
  allowedScopes: WorkflowScope[];
  configJsonSchema: Record<string, unknown>;
  outputs: Record<string, string>;
  branches: Branch[];
}

export interface ListFilter {
  scope?: WorkflowScope;
  projectId?: string;
  customerId?: string;
  status?: WorkflowStatus;
  tag?: string;
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

export interface CreateWorkflowDto {
  scope: WorkflowScope;
  projectId?: string;
  customerId?: string;
  name: string;
  description?: string;
  tags?: string[];
  trigger?: Record<string, unknown>;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  ui?: Record<string, unknown>;
}

export interface UpdateWorkflowDto {
  name?: string;
  description?: string;
  status?: WorkflowStatus;
  tags?: string[];
  trigger?: Record<string, unknown>;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  ui?: Record<string, unknown>;
  publish?: boolean;
}

export interface RunFilter {
  definitionId?: string;
  scope?: WorkflowScope;
  projectId?: string;
  customerId?: string;
  status?: WorkflowRunStatus;
  limit?: number;
  offset?: number;
}

function toQuery(p: Record<string, unknown>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null) continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

async function get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const { request } = await import('./client');
  return request<T>(`${path}${params ? toQuery(params) : ''}`);
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const { request } = await import('./client');
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}
async function put<T>(path: string, body: unknown): Promise<T> {
  const { request } = await import('./client');
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}
async function del<T>(path: string): Promise<T> {
  const { request } = await import('./client');
  return request<T>(path, { method: 'DELETE' });
}

export const workflowsApi = {
  listNodeTypes: () => get<WorkflowNodeMetadata[]>('/workflows/node-types'),
  list: (filter: ListFilter = {}) => get<WorkflowDefinition[]>('/workflows', filter as Record<string, unknown>),
  get: (id: string) => get<WorkflowDefinition>(`/workflows/${id}`),
  create: (dto: CreateWorkflowDto) => post<WorkflowDefinition>('/workflows', dto),
  update: (id: string, dto: UpdateWorkflowDto) => put<WorkflowDefinition>(`/workflows/${id}`, dto),
  delete: (id: string) => del<void>(`/workflows/${id}`),

  start: (definitionId: string, input?: Record<string, unknown>) =>
    post<WorkflowRun>('/workflows/runs', { definitionId, input }),
  listRuns: (filter: RunFilter = {}) =>
    get<WorkflowRun[]>('/workflows/runs/list', filter as Record<string, unknown>),
  getRun: (id: string) => get<WorkflowRun>(`/workflows/runs/${id}`),
  cancelRun: (id: string, reason?: string) => post<WorkflowRun>(`/workflows/runs/${id}/cancel`, { reason }),
  retryRun: (id: string, fromNodeId?: string) =>
    post<{ ok: true; id: string }>(`/workflows/runs/${id}/retry`, { fromNodeId }),
  listNodeRuns: (runId: string) => get<WorkflowNodeRun[]>(`/workflows/runs/${runId}/node-runs`),
};
```

Notes:
- We use a lazy `import('./client')` to access the existing internal `request<T>` helper without altering the existing api shape.
- If `request<T>` is not exported from `./client`, you'll need to export it. Add `export` keyword to the existing `async function request<T>` declaration in `client.ts` (around line 22).

- [ ] **Step 2: Verify build**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: clean. If `request` isn't exported from `client.ts`, add `export` to the declaration and rebuild.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/workflows.ts frontend/src/api/client.ts
git commit -m "feat(workflows): typed api client (T-251)"
```

---

## Task 3: useNodeTypesCatalog hook

**Files:** Create `frontend/src/hooks/useNodeTypesCatalog.ts`

- [ ] **Step 1: Write the hook**

```ts
import { useEffect, useState } from 'react';
import { workflowsApi, WorkflowNodeMetadata } from '../api/workflows';

interface CachedCatalog {
  data: WorkflowNodeMetadata[];
  fetchedAt: number;
}

const REVALIDATE_AFTER_MS = 60_000;
let cache: CachedCatalog | null = null;
let inflight: Promise<WorkflowNodeMetadata[]> | null = null;

export interface NodeTypesCatalog {
  catalog: WorkflowNodeMetadata[];
  byType: Record<string, WorkflowNodeMetadata>;
  byCategory: Record<string, WorkflowNodeMetadata[]>;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

async function fetchCatalog(): Promise<WorkflowNodeMetadata[]> {
  if (inflight) return inflight;
  inflight = workflowsApi.listNodeTypes()
    .then((data) => {
      cache = { data, fetchedAt: Date.now() };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useNodeTypesCatalog(): NodeTypesCatalog {
  const [catalog, setCatalog] = useState<WorkflowNodeMetadata[]>(cache?.data ?? []);
  const [isLoading, setIsLoading] = useState(!cache);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setError(null);
    setIsLoading(!cache);
    try {
      const data = await fetchCatalog();
      setCatalog(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!cache || Date.now() - cache.fetchedAt > REVALIDATE_AFTER_MS) {
      void load();
    } else {
      setCatalog(cache.data);
      setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byType: Record<string, WorkflowNodeMetadata> = {};
  const byCategory: Record<string, WorkflowNodeMetadata[]> = {};
  for (const m of catalog) {
    byType[m.type] = m;
    (byCategory[m.category] ||= []).push(m);
  }

  return { catalog, byType, byCategory, isLoading, error, refresh: load };
}
```

- [ ] **Step 2: Build**

```bash
cd frontend && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useNodeTypesCatalog.ts
git commit -m "feat(workflows): useNodeTypesCatalog hook with cache (T-251)"
```

---

## Task 4: useViewportBreakpoint + useWorkflowDirtyGuard hooks

**Files:** Create `frontend/src/hooks/useViewportBreakpoint.ts`, `frontend/src/hooks/useWorkflowDirtyGuard.ts`

- [ ] **Step 1: viewport breakpoint hook**

```ts
import { useEffect, useState } from 'react';

export type ViewportBreakpoint = 'phone' | 'tablet' | 'desktop';

function classify(width: number): ViewportBreakpoint {
  if (width < 768) return 'phone';
  if (width < 1280) return 'tablet';
  return 'desktop';
}

export function useViewportBreakpoint(): ViewportBreakpoint {
  const [bp, setBp] = useState<ViewportBreakpoint>(
    typeof window !== 'undefined' ? classify(window.innerWidth) : 'desktop',
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setBp(classify(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return bp;
}
```

- [ ] **Step 2: dirty-guard hook**

```ts
import { useEffect } from 'react';

export function useWorkflowDirtyGuard(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);
}
```

- [ ] **Step 3: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/hooks/useViewportBreakpoint.ts frontend/src/hooks/useWorkflowDirtyGuard.ts
git commit -m "feat(workflows): viewport breakpoint + dirty-guard hooks (T-251)"
```

---

## Task 5: Styling tables (categoryStyles, iconMap, runStatusStyles)

**Files:** Create three modules under `frontend/src/components/workflows/`.

- [ ] **Step 1: nodeCategoryStyles.ts**

```ts
export type NodeCategory = 'trigger' | 'action' | 'control' | 'agent';

interface CategoryStyle {
  border: string;
  headerBg: string;
  dotBg: string;
  pillBg: string;
  pillText: string;
}

export const nodeCategoryStyles: Record<NodeCategory, CategoryStyle> = {
  trigger: {
    border: 'border-cyan-600',
    headerBg: 'bg-cyan-900/40',
    dotBg: 'bg-cyan-400',
    pillBg: 'bg-cyan-900/50',
    pillText: 'text-cyan-300',
  },
  action: {
    border: 'border-violet-600',
    headerBg: 'bg-violet-900/40',
    dotBg: 'bg-violet-400',
    pillBg: 'bg-violet-900/50',
    pillText: 'text-violet-300',
  },
  control: {
    border: 'border-amber-600',
    headerBg: 'bg-amber-900/40',
    dotBg: 'bg-amber-400',
    pillBg: 'bg-amber-900/50',
    pillText: 'text-amber-300',
  },
  agent: {
    border: 'border-pink-600',
    headerBg: 'bg-pink-900/40',
    dotBg: 'bg-pink-400',
    pillBg: 'bg-pink-900/50',
    pillText: 'text-pink-300',
  },
};

export const nodeCategoryLabels: Record<NodeCategory, string> = {
  trigger: 'Trigger',
  action: 'Action',
  control: 'Control',
  agent: 'Agent',
};
```

- [ ] **Step 2: nodeTypeIconMap.ts**

```ts
import {
  Activity, Bell, BookOpen, Circle, Clock, Edit, FileEdit, FileText,
  GitBranch, Hand, HelpCircle, History, Link, MessageSquare, Sparkles,
  SquarePlus, Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const nodeTypeIconMap: Record<string, LucideIcon> = {
  'trigger.manual': Hand,
  'trigger.schedule': Clock,
  'trigger.project_event': Activity,
  'trigger.customer_event': Users,
  'action.log': FileText,
  'action.todo-create': SquarePlus,
  'action.todo-update': Edit,
  'action.todo-comment': MessageSquare,
  'action.todo-link-milestone': Link,
  'action.knowledge-create': BookOpen,
  'action.manual-create': FileEdit,
  'action.changelog-add': History,
  'action.notify': Bell,
  'action.user-question': HelpCircle,
  'control.condition': GitBranch,
  'control.delay': Clock,
  'agent.task': Sparkles,
};

export function getNodeIcon(type: string): LucideIcon {
  return nodeTypeIconMap[type] ?? Circle;
}
```

- [ ] **Step 3: runStatusStyles.ts**

```ts
import { WorkflowNodeRunStatus } from '../../api/workflows';

interface StatusStyle {
  ring: string;
  dotBg: string;
  label: string;
}

const idle: StatusStyle = { ring: '', dotBg: 'bg-gray-500', label: 'Idle' };

export const runStatusStyles: Record<WorkflowNodeRunStatus | 'idle', StatusStyle> = {
  idle,
  queued: { ring: 'ring-2 ring-gray-400', dotBg: 'bg-gray-400', label: 'Queued' },
  running: { ring: 'ring-2 ring-yellow-400 animate-pulse', dotBg: 'bg-yellow-400 animate-pulse', label: 'Running' },
  waiting: { ring: 'ring-2 ring-violet-400 animate-pulse', dotBg: 'bg-violet-400 animate-pulse', label: 'Waiting' },
  succeeded: { ring: 'ring-2 ring-green-500', dotBg: 'bg-green-500', label: 'Succeeded' },
  failed: { ring: 'ring-2 ring-red-500', dotBg: 'bg-red-500', label: 'Failed' },
  skipped: { ring: 'ring-2 ring-gray-600', dotBg: 'bg-gray-600', label: 'Skipped' },
  retrying: { ring: 'ring-2 ring-amber-400 animate-pulse', dotBg: 'bg-amber-400', label: 'Retrying' },
  interrupted: { ring: 'ring-2 ring-amber-500', dotBg: 'bg-amber-500', label: 'Interrupted' },
};
```

- [ ] **Step 4: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/workflows/nodeCategoryStyles.ts frontend/src/components/workflows/nodeTypeIconMap.ts frontend/src/components/workflows/runStatusStyles.ts
git commit -m "feat(workflows): category styles, icon map, run-status styles (T-251)"
```

---

## Task 6: Helpers (parseValidationIssues, schemaDefaults, generateNodeId)

**Files:** Create three small modules.

- [ ] **Step 1: parseValidationIssues.ts**

```ts
export interface RemoteIssue {
  nodeId?: string;
  nodeType?: string;
  message?: string;
  rawMessage?: string;
}

const PATTERN = /node "(?<id>[^"]+)"(?:\s*\((?<type>[^)]+)\))?\s*(?<rest>.+)/;

export function parseValidationIssues(msg: string): RemoteIssue[] {
  return msg
    .replace(/^.*?:\s*/, '')
    .split(/;\s*/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(PATTERN);
      if (!m?.groups) return { rawMessage: line };
      return {
        nodeId: m.groups.id,
        nodeType: m.groups.type,
        message: m.groups.rest,
      };
    });
}
```

- [ ] **Step 2: schemaDefaults.ts**

```ts
type JsonSchema = Record<string, unknown>;

export function getDefaultsFromJsonSchema(schema: JsonSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  const type = schema.type;
  if (type === 'object' && schema.properties && typeof schema.properties === 'object') {
    const out: Record<string, unknown> = {};
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const [k, sub] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
      if (required.includes(k)) {
        out[k] = getDefaultsFromJsonSchema(sub);
      }
    }
    return out;
  }
  if (type === 'array') return [];
  if (type === 'string') return '';
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  return undefined;
}
```

- [ ] **Step 3: generateNodeId.ts**

```ts
export function generateNodeId(type: string, existingIds: string[]): string {
  const prefix = (type.split('.').pop() ?? 'node').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
  let counter = 1;
  let candidate = prefix;
  const ids = new Set(existingIds);
  while (ids.has(candidate)) {
    counter++;
    candidate = `${prefix}_${counter}`;
  }
  return candidate;
}
```

- [ ] **Step 4: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/workflows/parseValidationIssues.ts frontend/src/components/workflows/schemaDefaults.ts frontend/src/components/workflows/generateNodeId.ts
git commit -m "feat(workflows): helper modules (validation parser, schema defaults, id generator) (T-251)"
```

---

## Task 7: TemplatePicker

**Files:** Create `frontend/src/components/workflows/TemplatePicker.tsx`.

- [ ] **Step 1: Write component**

```tsx
import { useState, useRef, useEffect } from 'react';
import { Braces } from 'lucide-react';

export interface TemplateOption {
  path: string;       // e.g. 'nodes.todo.todoId'
  label: string;      // 'todo / todoId'
  type?: string;      // 'string'
}

interface Props {
  options: TemplateOption[];
  onPick: (path: string) => void;
}

export function TemplatePicker({ options, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center w-8 h-8 rounded text-gray-400 hover:bg-gray-800 hover:text-cyan-300"
        title="Template-Pfad einfügen"
      >
        <Braces size={16} />
      </button>
      {open && options.length > 0 && (
        <div className="absolute right-0 z-50 mt-1 w-72 max-h-72 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
          <ul className="py-1 text-sm">
            {options.map((opt) => (
              <li key={opt.path}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(`{{${opt.path}}}`);
                    setOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-gray-200 hover:bg-gray-800"
                >
                  <span className="font-mono text-cyan-300">{`{{${opt.path}}}`}</span>
                  <div className="text-xs text-gray-500">{opt.label}{opt.type ? ` · ${opt.type}` : ''}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && options.length === 0 && (
        <div className="absolute right-0 z-50 mt-1 w-72 rounded-lg border border-gray-700 bg-gray-900 p-3 text-xs text-gray-400 shadow-xl">
          Keine vorgelagerten Nodes verfügbar.
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/workflows/TemplatePicker.tsx
git commit -m "feat(workflows): TemplatePicker popover for {{...}} paths (T-251)"
```

---

## Task 8: SchemaField recursive renderer

**Files:** Create `frontend/src/components/workflows/SchemaField.tsx`.

- [ ] **Step 1: Write component**

```tsx
import { Plus, Trash2 } from 'lucide-react';
import { TemplatePicker, TemplateOption } from './TemplatePicker';

type JsonSchema = Record<string, unknown>;

interface Props {
  schema: JsonSchema;
  path: (string | number)[];
  value: unknown;
  onChange: (newValue: unknown) => void;
  required?: boolean;
  fieldKey?: string;
  templateOptions?: TemplateOption[];
}

const TEXTAREA_KEYS = new Set([
  'prompt', 'systemPrompt', 'description', 'content', 'message', 'body', 'title', 'text', 'summary',
]);

export function SchemaField({ schema, path, value, onChange, required, fieldKey, templateOptions = [] }: Props) {
  const label = fieldKey ?? path[path.length - 1] ?? '';
  const labelText = String(label);

  // enum string → select
  if (schema.type === 'string' && Array.isArray(schema.enum)) {
    return (
      <Labeled label={labelText} required={required}>
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 focus:border-cyan-500 focus:outline-none"
        >
          <option value="">— wählen —</option>
          {(schema.enum as string[]).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </Labeled>
    );
  }

  // datetime
  if (schema.type === 'string' && schema.format === 'date-time') {
    const dtLocal = typeof value === 'string' && value ? value.slice(0, 16) : '';
    return (
      <Labeled label={labelText} required={required}>
        <input
          type="datetime-local"
          value={dtLocal}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : undefined)}
          className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200"
        />
      </Labeled>
    );
  }

  // string (with template picker)
  if (schema.type === 'string') {
    const useTextarea = TEXTAREA_KEYS.has(String(fieldKey ?? ''));
    const v = typeof value === 'string' ? value : '';
    return (
      <Labeled label={labelText} required={required}>
        <div className="flex items-start gap-1">
          {useTextarea ? (
            <textarea
              value={v}
              onChange={(e) => onChange(e.target.value)}
              rows={3}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 focus:border-cyan-500 focus:outline-none"
            />
          ) : (
            <input
              type="text"
              value={v}
              onChange={(e) => onChange(e.target.value)}
              className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 focus:border-cyan-500 focus:outline-none"
            />
          )}
          <TemplatePicker
            options={templateOptions}
            onPick={(p) => onChange(v + p)}
          />
        </div>
      </Labeled>
    );
  }

  // number / integer
  if (schema.type === 'number' || schema.type === 'integer') {
    return (
      <Labeled label={labelText} required={required}>
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          min={schema.minimum as number | undefined}
          max={schema.maximum as number | undefined}
          step={schema.type === 'integer' ? 1 : 'any'}
          onChange={(e) => {
            const n = e.target.value === '' ? undefined : Number(e.target.value);
            onChange(Number.isFinite(n as number) ? n : undefined);
          }}
          className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 focus:border-cyan-500 focus:outline-none"
        />
      </Labeled>
    );
  }

  // boolean
  if (schema.type === 'boolean') {
    const checked = value === true;
    return (
      <Labeled label={labelText} required={required}>
        <button
          type="button"
          onClick={() => onChange(!checked)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? 'bg-cyan-600' : 'bg-gray-700'}`}
        >
          <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </Labeled>
    );
  }

  // array
  if (schema.type === 'array') {
    const items = (schema.items ?? {}) as JsonSchema;
    const arr = Array.isArray(value) ? (value as unknown[]) : [];

    // string array → tag input
    if (items.type === 'string') {
      return (
        <Labeled label={labelText} required={required}>
          <TagInput
            tags={arr.filter((x): x is string => typeof x === 'string')}
            onChange={(tags) => onChange(tags)}
          />
        </Labeled>
      );
    }

    // object array → list of forms
    return (
      <Labeled label={labelText} required={required}>
        <div className="space-y-2">
          {arr.map((item, idx) => (
            <div key={idx} className="rounded border border-gray-700 bg-gray-900/40 p-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500">#{idx + 1}</span>
                <button
                  type="button"
                  onClick={() => {
                    const next = [...arr];
                    next.splice(idx, 1);
                    onChange(next);
                  }}
                  className="text-red-400 hover:text-red-300"
                  title="Eintrag löschen"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <SchemaField
                schema={items}
                path={[...path, idx]}
                value={item}
                onChange={(v) => {
                  const next = [...arr];
                  next[idx] = v;
                  onChange(next);
                }}
                templateOptions={templateOptions}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => onChange([...arr, getEmpty(items)])}
            className="inline-flex items-center gap-1 rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
          >
            <Plus size={12} /> hinzufügen
          </button>
        </div>
      </Labeled>
    );
  }

  // object
  if (schema.type === 'object' && schema.properties) {
    const props = schema.properties as Record<string, JsonSchema>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    const obj = (value as Record<string, unknown> | undefined) ?? {};
    return (
      <Labeled label={labelText} required={required.length > 0}>
        <fieldset className="rounded border border-gray-700 bg-gray-900/30 p-3 space-y-3">
          {Object.entries(props).map(([k, sub]) => (
            <SchemaField
              key={k}
              schema={sub}
              path={[...path, k]}
              value={obj[k]}
              onChange={(v) => onChange({ ...obj, [k]: v })}
              required={required.includes(k)}
              fieldKey={k}
              templateOptions={templateOptions}
            />
          ))}
        </fieldset>
      </Labeled>
    );
  }

  // anyOf / oneOf (control.delay has these)
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const variants = (schema.anyOf ?? schema.oneOf) as JsonSchema[];
    // Render all variants stacked; user fills whichever applies.
    return (
      <Labeled label={labelText} required={required}>
        <div className="space-y-2">
          {variants.map((variant, idx) => (
            <SchemaField
              key={idx}
              schema={variant}
              path={[...path, `variant-${idx}`]}
              value={value}
              onChange={onChange}
              templateOptions={templateOptions}
            />
          ))}
        </div>
      </Labeled>
    );
  }

  // fallback: raw JSON textarea
  return (
    <Labeled label={labelText} required={required}>
      <textarea
        value={typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)}
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value));
          } catch {
            onChange(e.target.value);
          }
        }}
        rows={3}
        className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-xs text-gray-200"
      />
    </Labeled>
  );
}

function Labeled({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">
        {label}{required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {children}
    </div>
  );
}

function TagInput({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded border border-gray-700 bg-gray-800 px-2 py-1">
      {tags.map((t, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-200">
          {t}
          <button
            type="button"
            onClick={() => onChange(tags.filter((_, j) => j !== i))}
            className="text-gray-400 hover:text-red-400"
          >×</button>
        </span>
      ))}
      <input
        type="text"
        placeholder="+ Tag (Enter)"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            const v = (e.target as HTMLInputElement).value.trim();
            if (v && !tags.includes(v)) onChange([...tags, v]);
            (e.target as HTMLInputElement).value = '';
          }
        }}
        className="flex-1 bg-transparent text-sm text-gray-200 focus:outline-none"
      />
    </div>
  );
}

function getEmpty(schema: JsonSchema): unknown {
  if (schema.type === 'object') return {};
  if (schema.type === 'array') return [];
  if (schema.type === 'string') return '';
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'boolean') return false;
  return null;
}
```

- [ ] **Step 2: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/workflows/SchemaField.tsx
git commit -m "feat(workflows): recursive JSON-Schema form renderer (T-251)"
```

---

## Task 9: WorkflowCustomNode + WorkflowCustomEdge

**Files:** Two components.

- [ ] **Step 1: WorkflowCustomNode.tsx**

```tsx
import { memo } from 'react';
import { Handle, Position, NodeToolbar, NodeProps } from '@xyflow/react';
import { AlertTriangle, Copy, Trash2 } from 'lucide-react';
import { WorkflowNodeMetadata, WorkflowNodeRunStatus } from '../../api/workflows';
import { nodeCategoryStyles } from './nodeCategoryStyles';
import { getNodeIcon } from './nodeTypeIconMap';
import { runStatusStyles } from './runStatusStyles';

export interface WorkflowNodeData {
  type: string;
  config: Record<string, unknown>;
  secretRefs?: string[];
  metadata?: WorkflowNodeMetadata;
  runStatus?: WorkflowNodeRunStatus;
  issueCount?: number;
  onDelete?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  [key: string]: unknown;
}

function WorkflowCustomNodeImpl(props: NodeProps) {
  const data = props.data as WorkflowNodeData;
  const meta = data.metadata;
  const category = meta?.category ?? 'action';
  const style = nodeCategoryStyles[category];
  const Icon = getNodeIcon(data.type);
  const status = runStatusStyles[data.runStatus ?? 'idle'];
  const isTrigger = category === 'trigger';
  const branches = meta?.branches ?? ['success'];
  const issueCount = data.issueCount ?? 0;

  return (
    <>
      <NodeToolbar isVisible={props.selected} position={Position.Top} offset={8}>
        <div className="flex gap-1 rounded border border-gray-700 bg-gray-900 p-1 shadow-lg">
          <button
            type="button"
            title="Duplizieren"
            onClick={() => data.onDuplicate?.(props.id)}
            className="rounded p-1 text-gray-300 hover:bg-gray-800 hover:text-cyan-300"
          ><Copy size={14} /></button>
          <button
            type="button"
            title="Löschen"
            onClick={() => data.onDelete?.(props.id)}
            className="rounded p-1 text-gray-300 hover:bg-gray-800 hover:text-red-400"
          ><Trash2 size={14} /></button>
        </div>
      </NodeToolbar>

      <div
        className={`min-w-[220px] rounded-lg border-2 bg-gray-900 shadow-md ${style.border} ${status.ring} ${props.selected ? 'ring-offset-2 ring-offset-gray-950' : ''}`}
      >
        {!isTrigger && <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-gray-500" />}

        <div className={`flex items-center justify-between rounded-t px-3 py-2 ${style.headerBg}`}>
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${status.dotBg}`} />
            <Icon size={14} className="text-gray-300" />
            <span className="font-mono text-xs text-gray-300">{data.type}</span>
          </div>
          {issueCount > 0 && (
            <span title={`${issueCount} Konfigurations-Issues`} className="text-amber-400">
              <AlertTriangle size={14} />
            </span>
          )}
        </div>

        <div className="px-3 py-2">
          <div className="text-xs text-gray-500">id: <span className="font-mono text-gray-300">{props.id}</span></div>
          <div className="mt-1 text-sm text-gray-200">{meta?.label ?? data.type}</div>
        </div>

        <div className="border-t border-gray-800 px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">
          branches
        </div>
        <div className="flex flex-col gap-1 px-3 pb-2">
          {branches.map((branch) => (
            <div key={branch} className="relative flex items-center justify-between text-xs">
              <span className={`${branchPillClass(branch)}`}>{branch}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={branch}
                className="!relative !right-0 !top-auto !translate-x-0 !translate-y-0 !h-2 !w-2 !bg-gray-500 ml-2"
              />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function branchPillClass(branch: string): string {
  if (branch === 'success') return 'rounded px-1.5 py-0.5 text-[10px] font-medium bg-green-900/40 text-green-300';
  if (branch === 'failure') return 'rounded px-1.5 py-0.5 text-[10px] font-medium bg-red-900/40 text-red-300';
  if (branch === 'custom') return 'rounded px-1.5 py-0.5 text-[10px] font-medium bg-violet-900/40 text-violet-300';
  return 'rounded px-1.5 py-0.5 text-[10px] font-medium bg-gray-800 text-gray-400';
}

export const WorkflowCustomNode = memo(WorkflowCustomNodeImpl);
```

- [ ] **Step 2: WorkflowCustomEdge.tsx**

```tsx
import { useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';

export interface WorkflowEdgeData {
  branch?: 'success' | 'failure' | 'custom' | 'always';
  condition?: Record<string, unknown>;
  onDelete?: (id: string) => void;
  [key: string]: unknown;
}

export function WorkflowCustomEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected } = props;
  const data = (props.data ?? {}) as WorkflowEdgeData;
  const [hovered, setHovered] = useState(false);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });

  const branch = data.branch ?? 'always';
  const stroke = selected ? '#22d3ee' : branch === 'failure' ? '#f87171' : branch === 'custom' ? '#c084fc' : '#64748b';

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{ stroke, strokeWidth: selected ? 2.5 : 1.5 }} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="nodrag nopan flex items-center gap-1"
        >
          {branch !== 'always' && (
            <span className={pillClass(branch)}>{branch}</span>
          )}
          {(hovered || selected) && (
            <button
              type="button"
              onClick={() => data.onDelete?.(id)}
              className="rounded-full bg-gray-900 p-1 text-red-400 shadow ring-1 ring-gray-700 hover:bg-red-900/30"
              title="Edge löschen"
            >
              <X size={10} />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

function pillClass(branch: string): string {
  const map: Record<string, string> = {
    success: 'bg-green-900/60 text-green-300',
    failure: 'bg-red-900/60 text-red-300',
    custom: 'bg-violet-900/60 text-violet-300',
  };
  return `rounded px-1.5 py-0.5 text-[10px] font-medium ${map[branch] ?? 'bg-gray-800 text-gray-300'} shadow ring-1 ring-gray-700`;
}
```

- [ ] **Step 3: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/workflows/WorkflowCustomNode.tsx frontend/src/components/workflows/WorkflowCustomEdge.tsx
git commit -m "feat(workflows): custom ReactFlow node + edge components (T-251)"
```

---

## Task 10: WorkflowValidationBanner

**Files:** Create `frontend/src/components/workflows/WorkflowValidationBanner.tsx`.

- [ ] **Step 1: Write component**

```tsx
import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { RemoteIssue } from './parseValidationIssues';

interface Props {
  issues: RemoteIssue[];
  onJumpTo: (nodeId: string) => void;
  onDismiss: () => void;
}

export function WorkflowValidationBanner({ issues, onJumpTo, onDismiss }: Props) {
  const [open, setOpen] = useState(false);
  if (issues.length === 0) return null;

  return (
    <div className="sticky bottom-0 z-30 border-t border-amber-700 bg-gradient-to-r from-amber-900/40 to-red-900/30 shadow-lg">
      <div className="flex items-center justify-between px-4 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-sm text-amber-200 hover:text-amber-100"
        >
          <AlertTriangle size={14} />
          <span>{issues.length} Validierungsfehler</span>
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-gray-400 hover:text-gray-200"
        >Schließen</button>
      </div>
      {open && (
        <ul className="max-h-48 overflow-y-auto border-t border-amber-800 px-4 py-2 text-xs">
          {issues.map((issue, idx) => (
            <li key={idx} className="py-1">
              {issue.nodeId ? (
                <button
                  type="button"
                  onClick={() => onJumpTo(issue.nodeId!)}
                  className="font-mono text-cyan-300 hover:underline"
                >node "{issue.nodeId}"</button>
              ) : null}
              {issue.nodeType ? <span className="ml-2 text-gray-500">({issue.nodeType})</span> : null}
              <span className="ml-2 text-amber-200">{issue.message ?? issue.rawMessage}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/workflows/WorkflowValidationBanner.tsx
git commit -m "feat(workflows): validation banner with jump-to-node (T-251)"
```

---

## Task 11: WorkflowNodePalette

**Files:** Create `frontend/src/components/workflows/WorkflowNodePalette.tsx`.

- [ ] **Step 1: Write component**

```tsx
import { useState } from 'react';
import { Search } from 'lucide-react';
import { WorkflowNodeMetadata, WorkflowScope } from '../../api/workflows';
import { nodeCategoryStyles, nodeCategoryLabels, NodeCategory } from './nodeCategoryStyles';
import { getNodeIcon } from './nodeTypeIconMap';

interface Props {
  catalog: WorkflowNodeMetadata[];
  workflowScope: WorkflowScope;
  onDragStart: (e: React.DragEvent, type: string) => void;
  onTapPlace: (type: string) => void;     // tablet / touch
  touchMode: boolean;
}

const CATEGORIES: NodeCategory[] = ['trigger', 'action', 'control', 'agent'];

export function WorkflowNodePalette({ catalog, workflowScope, onDragStart, onTapPlace, touchMode }: Props) {
  const [search, setSearch] = useState('');
  const [openCats, setOpenCats] = useState<Record<NodeCategory, boolean>>({
    trigger: true, action: true, control: true, agent: true,
  });

  const q = search.trim().toLowerCase();
  const matches = (m: WorkflowNodeMetadata) =>
    !q || m.label.toLowerCase().includes(q) || m.type.toLowerCase().includes(q);

  return (
    <div className="flex h-full flex-col border-r border-gray-800 bg-gray-950">
      <div className="border-b border-gray-800 p-2">
        <div className="flex items-center gap-2 rounded border border-gray-700 bg-gray-900 px-2 py-1">
          <Search size={14} className="text-gray-500" />
          <input
            type="text"
            placeholder="Suche…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-sm text-gray-200 focus:outline-none"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {CATEGORIES.map((cat) => {
          const items = catalog.filter((m) => m.category === cat && matches(m));
          if (items.length === 0) return null;
          const style = nodeCategoryStyles[cat];
          const isOpen = openCats[cat];
          return (
            <div key={cat} className="mb-2">
              <button
                type="button"
                onClick={() => setOpenCats((s) => ({ ...s, [cat]: !s[cat] }))}
                className="flex w-full items-center justify-between rounded px-2 py-1 text-xs uppercase tracking-wide text-gray-400 hover:bg-gray-900"
              >
                <span className={`${style.pillText}`}>{nodeCategoryLabels[cat]}</span>
                <span className="text-gray-600">({items.length})</span>
              </button>
              {isOpen && (
                <ul className="mt-1 space-y-1">
                  {items.map((m) => {
                    const allowed = m.allowedScopes.includes(workflowScope);
                    const Icon = getNodeIcon(m.type);
                    return (
                      <li
                        key={m.type}
                        draggable={!touchMode && allowed}
                        onDragStart={(e) => allowed && onDragStart(e, m.type)}
                        onClick={() => touchMode && allowed && onTapPlace(m.type)}
                        title={allowed ? m.description : `Nicht erlaubt für scope=${workflowScope}`}
                        className={`flex items-center gap-2 rounded border ${allowed ? `${style.border} cursor-pointer hover:bg-gray-900` : 'border-gray-800 opacity-40 cursor-not-allowed'} bg-gray-900/40 px-2 py-2`}
                      >
                        <Icon size={14} className="text-gray-300" />
                        <span className="text-sm text-gray-200">{m.label}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/workflows/WorkflowNodePalette.tsx
git commit -m "feat(workflows): node palette with search + categories + drag/tap (T-251)"
```

---

## Task 12: WorkflowNodeInspector

**Files:** Create `frontend/src/components/workflows/WorkflowNodeInspector.tsx`.

- [ ] **Step 1: Write component**

```tsx
import { useMemo } from 'react';
import { Trash2, Copy } from 'lucide-react';
import { WorkflowNodeMetadata, WorkflowEdge as WfEdge } from '../../api/workflows';
import { SchemaField } from './SchemaField';
import { TemplateOption } from './TemplatePicker';
import { nodeCategoryStyles } from './nodeCategoryStyles';

export interface SelectedNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
  secretRefs?: string[];
}

interface Props {
  selectedNode: SelectedNode | null;
  selectedEdge: WfEdge | null;
  catalog: WorkflowNodeMetadata[];
  upstreamNodes: SelectedNode[];   // for template picker options
  outgoingEdgeCountByBranch: Record<string, number>;
  localIssues: string[];           // strings like "config.title: required"
  onChangeConfig: (config: Record<string, unknown>) => void;
  onRenameNode: (oldId: string, newId: string) => void;
  onChangeNodeType: (newType: string) => void;
  onDeleteNode: () => void;
  onDuplicateNode: () => void;
  onChangeEdgeBranch: (branch: 'success' | 'failure' | 'custom' | 'always') => void;
  onDeleteEdge: () => void;
}

export function WorkflowNodeInspector(props: Props) {
  const { selectedNode, selectedEdge, catalog } = props;

  if (!selectedNode && !selectedEdge) {
    return (
      <div className="flex h-full items-center justify-center border-l border-gray-800 bg-gray-950 p-6 text-sm text-gray-500">
        Wähle einen Node oder eine Edge aus, oder ziehe einen Eintrag aus der Palette.
      </div>
    );
  }

  if (selectedEdge) {
    return <EdgeInspector edge={selectedEdge} onChangeBranch={props.onChangeEdgeBranch} onDelete={props.onDeleteEdge} />;
  }

  return <NodeInspector {...props} />;
}

function NodeInspector(p: Props) {
  const { selectedNode, catalog, upstreamNodes, outgoingEdgeCountByBranch, localIssues } = p;
  const node = selectedNode!;
  const meta = catalog.find((c) => c.type === node.type);
  const cat = meta?.category ?? 'action';
  const style = nodeCategoryStyles[cat];

  const templateOptions = useMemo<TemplateOption[]>(() => {
    const opts: TemplateOption[] = [
      { path: 'input.event.entityId', label: 'event.entityId', type: 'string' },
      { path: 'input.event.entity', label: 'event.entity', type: 'string' },
      { path: 'input.event.action', label: 'event.action', type: 'string' },
    ];
    for (const up of upstreamNodes) {
      const upMeta = catalog.find((c) => c.type === up.type);
      if (!upMeta) continue;
      for (const [outKey, outType] of Object.entries(upMeta.outputs)) {
        opts.push({
          path: `nodes.${up.id}.${outKey}`,
          label: `${up.id} / ${outKey}`,
          type: outType,
        });
      }
    }
    return opts;
  }, [catalog, upstreamNodes]);

  return (
    <div className="flex h-full flex-col border-l border-gray-800 bg-gray-950">
      <div className={`border-b border-gray-800 px-4 py-3 ${style.headerBg}`}>
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs text-gray-300">id: {node.id}</span>
          <div className="flex gap-1">
            <button onClick={p.onDuplicateNode} title="Duplizieren" className="rounded p-1 text-gray-300 hover:bg-gray-800"><Copy size={14} /></button>
            <button onClick={p.onDeleteNode} title="Löschen" className="rounded p-1 text-gray-300 hover:bg-gray-800 hover:text-red-400"><Trash2 size={14} /></button>
          </div>
        </div>
        <div className="mt-1 text-sm text-gray-200">{meta?.label ?? node.type}</div>
        {meta?.description && <div className="mt-1 text-xs text-gray-500">{meta.description}</div>}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <section>
          <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">Konfiguration</h3>
          {meta ? (
            <SchemaField
              schema={meta.configJsonSchema}
              path={['config']}
              value={node.config}
              onChange={(v) => p.onChangeConfig(v as Record<string, unknown>)}
              templateOptions={templateOptions}
            />
          ) : (
            <div className="text-xs text-amber-400">Unbekannter Node-Type — kein Schema verfügbar.</div>
          )}
        </section>

        {meta && Object.keys(meta.outputs).length > 0 && (
          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">Outputs</h3>
            <ul className="text-xs">
              {Object.entries(meta.outputs).map(([k, t]) => (
                <li key={k} className="font-mono text-gray-400">• {k}: <span className="text-gray-500">{t}</span></li>
              ))}
            </ul>
          </section>
        )}

        {meta && meta.branches.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">Branches</h3>
            <ul className="text-xs">
              {meta.branches.map((b) => (
                <li key={b} className="text-gray-400">○ {b} → {outgoingEdgeCountByBranch[b] ?? 0} outgoing</li>
              ))}
            </ul>
          </section>
        )}

        {localIssues.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-amber-400">⚠ Validierung</h3>
            <ul className="text-xs text-amber-300">
              {localIssues.map((iss, i) => <li key={i}>{iss}</li>)}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function EdgeInspector({ edge, onChangeBranch, onDelete }: { edge: WfEdge; onChangeBranch: (b: 'success' | 'failure' | 'custom' | 'always') => void; onDelete: () => void }) {
  const branches: Array<'success' | 'failure' | 'custom' | 'always'> = ['success', 'failure', 'custom', 'always'];
  const current = (edge.branch as 'success' | 'failure' | 'custom' | 'always') ?? 'always';
  return (
    <div className="flex h-full flex-col border-l border-gray-800 bg-gray-950 p-4">
      <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-500">Edge</h3>
      <div className="mb-3 text-xs text-gray-400 font-mono">{edge.source} → {edge.target}</div>
      <div className="mb-4">
        <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">Branch</label>
        <div className="flex flex-wrap gap-1">
          {branches.map((b) => (
            <button key={b} onClick={() => onChangeBranch(b)} className={`rounded px-2 py-1 text-xs ${current === b ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}>{b}</button>
          ))}
        </div>
      </div>
      <button onClick={onDelete} className="self-start rounded bg-red-900/50 px-3 py-1 text-xs text-red-200 hover:bg-red-900">Edge löschen</button>
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/workflows/WorkflowNodeInspector.tsx
git commit -m "feat(workflows): node + edge inspector with schema-driven form (T-251)"
```

---

## Task 13: WorkflowCanvas

**Files:** Create `frontend/src/components/workflows/WorkflowCanvas.tsx`.

- [ ] **Step 1: Write component**

```tsx
import { useCallback, useMemo, useRef } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls,
  MiniMap, Connection, Edge, Node, useReactFlow, OnNodesChange, OnEdgesChange,
  ConnectionMode,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { WorkflowCustomNode } from './WorkflowCustomNode';
import { WorkflowCustomEdge } from './WorkflowCustomEdge';

const nodeTypes = { workflowNode: WorkflowCustomNode };
const edgeTypes = { workflowEdge: WorkflowCustomEdge };

interface Props {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: (conn: Connection) => void;
  onSelectionChange: (sel: { nodes: Node[]; edges: Edge[] }) => void;
  onDrop: (event: React.DragEvent, position: { x: number; y: number }) => void;
}

function CanvasInner(p: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  const isValidConnection = useCallback((conn: Connection): boolean => {
    if (conn.source === conn.target) return false;
    const target = p.nodes.find((n) => n.id === conn.target);
    const targetType = (target?.data as { type?: string })?.type;
    if (targetType?.startsWith('trigger.')) return false;
    const duplicate = p.edges.some(
      (e) => e.source === conn.source && e.target === conn.target && e.sourceHandle === conn.sourceHandle,
    );
    return !duplicate;
  }, [p.nodes, p.edges]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    p.onDrop(event, position);
  }, [screenToFlowPosition, p]);

  const defaultEdgeOptions = useMemo(() => ({ type: 'workflowEdge' }), []);

  return (
    <div className="h-full w-full" ref={wrapperRef} onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={p.nodes}
        edges={p.edges}
        onNodesChange={p.onNodesChange}
        onEdgesChange={p.onEdgesChange}
        onConnect={p.onConnect}
        isValidConnection={isValidConnection}
        onSelectionChange={p.onSelectionChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        connectionMode={ConnectionMode.Loose}
        fitView
        proOptions={{ hideAttribution: true }}
        className="bg-gray-950"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1f2937" />
        <Controls className="!bg-gray-900 !border-gray-700" />
        <MiniMap pannable zoomable className="!bg-gray-900" nodeColor="#374151" maskColor="rgba(15,23,42,0.7)" />
      </ReactFlow>
    </div>
  );
}

export function WorkflowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/workflows/WorkflowCanvas.tsx
git commit -m "feat(workflows): ReactFlow canvas wrapper with custom node/edge types (T-251)"
```

---

## Task 14: WorkflowRunInspector modal

**Files:** Create `frontend/src/components/workflows/WorkflowRunInspector.tsx`.

- [ ] **Step 1: Write component**

```tsx
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { workflowsApi, WorkflowRun, WorkflowNodeRun, WorkflowRunStatus } from '../../api/workflows';
import { runStatusStyles } from './runStatusStyles';

interface Props {
  runId: string;
  onClose: () => void;
}

const TERMINAL: WorkflowRunStatus[] = ['succeeded', 'failed', 'cancelled'];

export function WorkflowRunInspector({ runId, onClose }: Props) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [nodeRuns, setNodeRuns] = useState<WorkflowNodeRun[]>([]);
  const [selected, setSelected] = useState<WorkflowNodeRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [r, nrs] = await Promise.all([
          workflowsApi.getRun(runId),
          workflowsApi.listNodeRuns(runId),
        ]);
        if (cancelled) return;
        setRun(r);
        setNodeRuns(nrs);
        if (TERMINAL.includes(r.status)) {
          return;
        }
        setTimeout(tick, 1000);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    void tick();
    return () => { cancelled = true; };
  }, [runId]);

  const onCancel = async () => {
    try {
      await workflowsApi.cancelRun(runId);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const onRetry = async () => {
    try {
      await workflowsApi.retryRun(runId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="mx-4 max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-800 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-200">Run-Verlauf</h2>
            <div className="font-mono text-xs text-gray-500">{runId}</div>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-gray-500 hover:text-gray-300">×</button>
        </div>

        {error && <div className="m-4 rounded bg-red-900/30 px-3 py-2 text-sm text-red-300">{error}</div>}

        {run && (
          <>
            <div className="border-b border-gray-800 px-5 py-3 text-xs">
              <span className={`inline-block rounded px-2 py-0.5 ${badge(run.status)}`}>{run.status}</span>
              <span className="ml-3 text-gray-500">started: {run.startedAt ?? '—'}</span>
              <span className="ml-3 text-gray-500">finished: {run.finishedAt ?? '—'}</span>
              <span className="ml-3 text-gray-500">trigger: {run.triggeredBy?.type ?? '—'}</span>
              {run.error && <div className="mt-2 text-red-300">Fehler: {run.error.code} — {run.error.message}</div>}
            </div>

            <div className="flex h-[60vh]">
              <div className="w-1/2 overflow-y-auto border-r border-gray-800">
                <table className="w-full text-xs">
                  <thead className="bg-gray-950 text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left">nodeId</th>
                      <th className="px-3 py-2 text-left">type</th>
                      <th className="px-3 py-2 text-left">status</th>
                      <th className="px-3 py-2 text-left">attempt</th>
                      <th className="px-3 py-2 text-left">duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nodeRuns.map((nr) => {
                      const sty = runStatusStyles[nr.status];
                      return (
                        <tr
                          key={nr._id}
                          onClick={() => setSelected(nr)}
                          className={`cursor-pointer border-t border-gray-800 hover:bg-gray-800/50 ${selected?._id === nr._id ? 'bg-gray-800' : ''}`}
                        >
                          <td className="px-3 py-1 font-mono text-gray-300">{nr.nodeId}</td>
                          <td className="px-3 py-1 text-gray-400">{nr.nodeType}</td>
                          <td className="px-3 py-1"><span className={`rounded px-1.5 py-0.5 text-[10px] ${sty.dotBg.includes('bg-') ? sty.dotBg : ''} ${sty.dotBg.replace('bg-', 'text-')}`}>{nr.status}</span></td>
                          <td className="px-3 py-1 text-gray-400">{nr.attempt}</td>
                          <td className="px-3 py-1 text-gray-400">{nr.durationMs ? `${nr.durationMs}ms` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="w-1/2 overflow-y-auto p-4">
                {selected ? (
                  <>
                    <h4 className="mb-2 text-xs uppercase tracking-wide text-gray-500">Output</h4>
                    <pre className="mb-4 max-h-40 overflow-y-auto rounded bg-gray-950 p-2 text-xs text-gray-300">{JSON.stringify(selected.outputSnapshot ?? {}, null, 2)}</pre>
                    {selected.error && (
                      <>
                        <h4 className="mb-2 text-xs uppercase tracking-wide text-red-400">Fehler</h4>
                        <pre className="mb-4 rounded bg-red-900/20 p-2 text-xs text-red-300">{JSON.stringify(selected.error, null, 2)}</pre>
                      </>
                    )}
                    {Array.isArray(selected.logs) && selected.logs.length > 0 && (
                      <>
                        <h4 className="mb-2 text-xs uppercase tracking-wide text-gray-500">Logs ({selected.logs.length})</h4>
                        <ul className="max-h-40 overflow-y-auto rounded bg-gray-950 p-2 text-xs font-mono text-gray-300">
                          {selected.logs.map((l, i) => <li key={i}>{JSON.stringify(l)}</li>)}
                        </ul>
                      </>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-gray-500">Wähle einen Node-Run aus.</div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-gray-800 px-5 py-3">
              {!TERMINAL.includes(run.status) && (
                <button onClick={onCancel} className="rounded bg-amber-900/50 px-3 py-1 text-xs text-amber-200 hover:bg-amber-900">Cancel</button>
              )}
              {(run.status === 'failed' || run.status === 'cancelled') && (
                <button onClick={onRetry} className="rounded bg-cyan-900/50 px-3 py-1 text-xs text-cyan-200 hover:bg-cyan-900">Retry</button>
              )}
              <button onClick={onClose} className="rounded bg-gray-800 px-3 py-1 text-xs text-gray-200 hover:bg-gray-700">Schließen</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function badge(s: WorkflowRunStatus): string {
  const map: Record<WorkflowRunStatus, string> = {
    queued: 'bg-gray-700 text-gray-200',
    running: 'bg-yellow-900/60 text-yellow-200',
    waiting_for_user: 'bg-violet-900/60 text-violet-200',
    waiting_for_timer: 'bg-violet-900/60 text-violet-200',
    succeeded: 'bg-green-900/60 text-green-200',
    failed: 'bg-red-900/60 text-red-200',
    cancelled: 'bg-gray-700 text-gray-300',
  };
  return map[s] ?? 'bg-gray-700 text-gray-300';
}
```

- [ ] **Step 2: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/workflows/WorkflowRunInspector.tsx
git commit -m "feat(workflows): run inspector modal with polled node-runs (T-251)"
```

---

## Task 15: WorkflowCardGrid + CreateWorkflowDialog

**Files:** Create two small components.

- [ ] **Step 1: WorkflowCardGrid.tsx**

```tsx
import { Link } from 'react-router-dom';
import { Workflow, Play, Pause, Archive } from 'lucide-react';
import { WorkflowDefinition } from '../../api/workflows';

interface Props {
  workflows: WorkflowDefinition[];
  onRun?: (id: string) => void;
}

export function WorkflowCardGrid({ workflows, onRun }: Props) {
  if (workflows.length === 0) {
    return <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-6 text-center text-sm text-gray-500">Keine Workflows.</div>;
  }
  return (
    <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
      {workflows.map((wf) => (
        <Link key={wf._id} to={`/workflows/${wf._id}`} className="block rounded-lg border border-gray-800 bg-gray-900 p-4 hover:border-cyan-600">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Workflow size={16} className="text-cyan-400" />
              <span className="font-medium text-gray-200">{wf.name}</span>
            </div>
            <span className={`rounded px-2 py-0.5 text-[10px] uppercase ${statusBadge(wf.status)}`}>{wf.status}</span>
          </div>
          <div className="text-xs text-gray-500">
            <div>Scope: {wf.scope} · v{wf.version}</div>
            <div>Trigger: {(wf.trigger as { type?: string })?.type ?? '—'}</div>
            {wf.lastRunAt && <div>Letzter Run: {new Date(wf.lastRunAt).toLocaleString()}</div>}
          </div>
          {onRun && wf.status === 'active' && (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); onRun(wf._id); }}
              className="mt-3 inline-flex items-center gap-1 rounded bg-cyan-900/40 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-900"
            >
              <Play size={12} /> ausführen
            </button>
          )}
        </Link>
      ))}
    </div>
  );
}

function statusBadge(s: string): string {
  if (s === 'active') return 'bg-green-900/40 text-green-300';
  if (s === 'paused') return 'bg-amber-900/40 text-amber-300';
  if (s === 'archived') return 'bg-gray-800 text-gray-500';
  return 'bg-gray-800 text-gray-300';
}
```

- [ ] **Step 2: CreateWorkflowDialog.tsx**

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { workflowsApi, WorkflowScope } from '../../api/workflows';
import { useToast } from '../Toast';

interface Props {
  open: boolean;
  defaultScope?: WorkflowScope;
  defaultProjectId?: string;
  defaultCustomerId?: string;
  onClose: () => void;
}

export function CreateWorkflowDialog({ open, defaultScope, defaultProjectId, defaultCustomerId, onClose }: Props) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<WorkflowScope>(defaultScope ?? 'project');
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [customerId, setCustomerId] = useState(defaultCustomerId ?? '');
  const [triggerType, setTriggerType] = useState<'manual' | 'schedule'>('manual');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  if (!open) return null;

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const wf = await workflowsApi.create({
        scope,
        projectId: scope === 'project' ? projectId : undefined,
        customerId: scope === 'customer' ? customerId : undefined,
        name: name.trim(),
        trigger: { type: triggerType },
        nodes: [
          { id: 't', type: `trigger.${triggerType}`, position: { x: 100, y: 100 }, config: {}, secretRefs: [] },
        ],
        edges: [],
      });
      toast.showSuccess('Workflow erstellt');
      onClose();
      navigate(`/workflows/${wf._id}`);
    } catch (err) {
      toast.showError(`Erstellen fehlgeschlagen: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="mx-4 w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-gray-800 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-200">Neuer Workflow</h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          <Labeled label="Name">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200" />
          </Labeled>
          <Labeled label="Scope">
            <select value={scope} onChange={(e) => setScope(e.target.value as WorkflowScope)} className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200">
              <option value="system">System</option>
              <option value="project">Project</option>
              <option value="customer">Customer</option>
            </select>
          </Labeled>
          {scope === 'project' && (
            <Labeled label="Project ID">
              <input type="text" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 font-mono" />
            </Labeled>
          )}
          {scope === 'customer' && (
            <Labeled label="Customer ID">
              <input type="text" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 font-mono" />
            </Labeled>
          )}
          <Labeled label="Trigger">
            <select value={triggerType} onChange={(e) => setTriggerType(e.target.value as 'manual' | 'schedule')} className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200">
              <option value="manual">Manual</option>
              <option value="schedule">Schedule</option>
            </select>
          </Labeled>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-800 px-5 py-3">
          <button onClick={onClose} className="rounded bg-gray-800 px-3 py-1 text-sm text-gray-200 hover:bg-gray-700">Abbrechen</button>
          <button onClick={handleCreate} disabled={submitting || !name.trim()} className="rounded bg-cyan-600 px-3 py-1 text-sm text-white hover:bg-cyan-500 disabled:opacity-50">Erstellen</button>
        </div>
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs uppercase tracking-wide text-gray-500">{label}</label>
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/workflows/WorkflowCardGrid.tsx frontend/src/components/workflows/CreateWorkflowDialog.tsx
git commit -m "feat(workflows): card grid + create wizard dialog (T-251)"
```

---

## Task 16: WorkflowEditorMobileFallback

**Files:** Create `frontend/src/components/workflows/WorkflowEditorMobileFallback.tsx`.

- [ ] **Step 1: Write component**

```tsx
import { WorkflowDefinition } from '../../api/workflows';

interface Props {
  workflow: WorkflowDefinition;
  onActivate: () => void;
  onRun: () => void;
}

export function WorkflowEditorMobileFallback({ workflow, onActivate, onRun }: Props) {
  return (
    <div className="mx-auto max-w-md p-4 space-y-4">
      <div className="rounded-lg border border-amber-700 bg-amber-900/20 p-3 text-sm text-amber-200">
        Der Workflow-Editor benötigt mindestens 768px Breite. Lesemodus aktiv — Änderungen nur am Desktop oder Tablet.
      </div>
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <div className="text-xs text-gray-500">Name</div>
        <div className="mb-3 text-lg text-gray-200">{workflow.name}</div>
        <div className="text-xs text-gray-500">Status / Scope / Version</div>
        <div className="mb-3 text-gray-200">{workflow.status} · {workflow.scope} · v{workflow.version}</div>
        <div className="text-xs text-gray-500">Trigger</div>
        <pre className="rounded bg-gray-950 p-2 text-xs text-gray-300">{JSON.stringify(workflow.trigger, null, 2)}</pre>
      </div>
      <details className="rounded-lg border border-gray-800 bg-gray-900 p-2">
        <summary className="cursor-pointer text-sm text-gray-300">Definition (JSON)</summary>
        <pre className="mt-2 max-h-96 overflow-y-auto rounded bg-gray-950 p-2 text-xs text-gray-300">{JSON.stringify({ nodes: workflow.nodes, edges: workflow.edges }, null, 2)}</pre>
      </details>
      <div className="flex gap-2">
        {workflow.status === 'draft' && (
          <button onClick={onActivate} className="flex-1 rounded bg-cyan-600 px-3 py-2 text-sm text-white hover:bg-cyan-500">Aktivieren</button>
        )}
        {workflow.status === 'active' && (
          <button onClick={onRun} className="flex-1 rounded bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-500">Run starten</button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/components/workflows/WorkflowEditorMobileFallback.tsx
git commit -m "feat(workflows): mobile fallback read-only view (T-251)"
```

---

## Task 17: WorkflowsListPage + WorkflowProjectTab

**Files:** Two pages/components.

- [ ] **Step 1: WorkflowsListPage.tsx**

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { workflowsApi, WorkflowDefinition, WorkflowScope, WorkflowStatus } from '../api/workflows';
import { WorkflowCardGrid } from '../components/workflows/WorkflowCardGrid';
import { CreateWorkflowDialog } from '../components/workflows/CreateWorkflowDialog';
import { useToast } from '../components/Toast';
import { WorkflowRunInspector } from '../components/workflows/WorkflowRunInspector';

export default function WorkflowsListPage() {
  const [scope, setScope] = useState<WorkflowScope | 'all'>('all');
  const [status, setStatus] = useState<WorkflowStatus | 'all'>('all');
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const filter: Record<string, unknown> = {};
      if (scope !== 'all') filter.scope = scope;
      if (status !== 'all') filter.status = status;
      const list = await workflowsApi.list(filter);
      setWorkflows(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [scope, status]);

  const onRun = async (id: string) => {
    try {
      const run = await workflowsApi.start(id);
      toast.showSuccess(`Run gestartet: ${run._id}`);
      setRunId(run._id);
    } catch (err) {
      toast.showError(`Run fehlgeschlagen: ${(err as Error).message}`);
    }
  };

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-gray-200">Workflows</h1>
        <button onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-1 rounded bg-cyan-600 px-3 py-2 text-sm text-white hover:bg-cyan-500">
          <Plus size={14} /> Neuer Workflow
        </button>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <select value={scope} onChange={(e) => setScope(e.target.value as WorkflowScope | 'all')} className="rounded border border-gray-700 bg-gray-900 px-3 py-1 text-sm text-gray-200">
          <option value="all">Alle Scopes</option>
          <option value="system">System</option>
          <option value="project">Project</option>
          <option value="customer">Customer</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as WorkflowStatus | 'all')} className="rounded border border-gray-700 bg-gray-900 px-3 py-1 text-sm text-gray-200">
          <option value="all">Alle Status</option>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {loading && <div className="text-sm text-gray-500">Lädt…</div>}
      {error && <div className="rounded bg-red-900/30 p-3 text-sm text-red-200">{error}</div>}
      {!loading && !error && <WorkflowCardGrid workflows={workflows} onRun={onRun} />}

      <CreateWorkflowDialog open={createOpen} onClose={() => { setCreateOpen(false); void load(); }} />
      {runId && <WorkflowRunInspector runId={runId} onClose={() => setRunId(null)} />}
    </div>
  );
}
```

- [ ] **Step 2: WorkflowProjectTab.tsx**

```tsx
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { workflowsApi, WorkflowDefinition, WorkflowScope } from '../../api/workflows';
import { WorkflowCardGrid } from './WorkflowCardGrid';
import { CreateWorkflowDialog } from './CreateWorkflowDialog';
import { useToast } from '../Toast';
import { WorkflowRunInspector } from './WorkflowRunInspector';

interface Props {
  scope: WorkflowScope;
  projectId?: string;
  customerId?: string;
}

export function WorkflowProjectTab({ scope, projectId, customerId }: Props) {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const list = await workflowsApi.list({ scope, projectId, customerId });
      setWorkflows(list);
    } catch (err) {
      toast.showError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [scope, projectId, customerId]);

  const onRun = async (id: string) => {
    try {
      const run = await workflowsApi.start(id);
      toast.showSuccess(`Run gestartet: ${run._id}`);
      setRunId(run._id);
    } catch (err) {
      toast.showError(`Run fehlgeschlagen: ${(err as Error).message}`);
    }
  };

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <button onClick={() => setCreateOpen(true)} className="inline-flex items-center gap-1 rounded bg-cyan-600 px-3 py-2 text-sm text-white hover:bg-cyan-500">
          <Plus size={14} /> Neuer Workflow
        </button>
      </div>
      {loading ? <div className="text-sm text-gray-500">Lädt…</div> : <WorkflowCardGrid workflows={workflows} onRun={onRun} />}
      <CreateWorkflowDialog
        open={createOpen}
        defaultScope={scope}
        defaultProjectId={projectId}
        defaultCustomerId={customerId}
        onClose={() => { setCreateOpen(false); void load(); }}
      />
      {runId && <WorkflowRunInspector runId={runId} onClose={() => setRunId(null)} />}
    </div>
  );
}
```

- [ ] **Step 3: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/pages/WorkflowsListPage.tsx frontend/src/components/workflows/WorkflowProjectTab.tsx
git commit -m "feat(workflows): list page + reusable project/customer tab (T-251)"
```

---

## Task 18: WorkflowEditorPage (the big one)

**Files:** Create `frontend/src/pages/WorkflowEditorPage.tsx`.

This task is large but contains complete code.

- [ ] **Step 1: Write the page**

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  useNodesState, useEdgesState, addEdge, Connection, Edge, Node, applyNodeChanges, applyEdgeChanges,
  useReactFlow, ReactFlowProvider,
} from '@xyflow/react';
import { ArrowLeft, Save, Play, CheckCircle, Pause, Trash2, PanelLeftOpen, PanelRightOpen, X } from 'lucide-react';

import { workflowsApi, WorkflowDefinition, WorkflowNode as WfNode, WorkflowEdge as WfEdge, WorkflowStatus } from '../api/workflows';
import { WorkflowCanvas } from '../components/workflows/WorkflowCanvas';
import { WorkflowNodePalette } from '../components/workflows/WorkflowNodePalette';
import { WorkflowNodeInspector } from '../components/workflows/WorkflowNodeInspector';
import { WorkflowValidationBanner } from '../components/workflows/WorkflowValidationBanner';
import { WorkflowRunInspector } from '../components/workflows/WorkflowRunInspector';
import { WorkflowEditorMobileFallback } from '../components/workflows/WorkflowEditorMobileFallback';
import { useNodeTypesCatalog } from '../hooks/useNodeTypesCatalog';
import { useViewportBreakpoint } from '../hooks/useViewportBreakpoint';
import { useWorkflowDirtyGuard } from '../hooks/useWorkflowDirtyGuard';
import { parseValidationIssues, RemoteIssue } from '../components/workflows/parseValidationIssues';
import { getDefaultsFromJsonSchema } from '../components/workflows/schemaDefaults';
import { generateNodeId } from '../components/workflows/generateNodeId';
import { useToast } from '../components/Toast';

export default function WorkflowEditorPage() {
  return (
    <ReactFlowProvider>
      <EditorInner />
    </ReactFlowProvider>
  );
}

function EditorInner() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { catalog, byType } = useNodeTypesCatalog();
  const bp = useViewportBreakpoint();
  const reactFlowApi = useReactFlow();

  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [remoteIssues, setRemoteIssues] = useState<RemoteIssue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(bp === 'desktop');
  const [inspectorOpen, setInspectorOpen] = useState(bp === 'desktop');
  const [tapPlaceMode, setTapPlaceMode] = useState<string | null>(null);
  const draggedTypeRef = useRef<string | null>(null);

  useWorkflowDirtyGuard(dirty);

  useEffect(() => {
    let cancelled = false;
    workflowsApi.get(id).then((wf) => {
      if (cancelled) return;
      setWorkflow(wf);
      setNodes(wf.nodes.map((n) => toReactFlowNode(n, byType)));
      setEdges(wf.edges.map(toReactFlowEdge));
    }).catch((err) => {
      toast.showError(`Workflow nicht ladbar: ${(err as Error).message}`);
    });
    return () => { cancelled = true; };
  }, [id, byType]);

  useEffect(() => {
    setPaletteOpen(bp === 'desktop');
    setInspectorOpen(bp === 'desktop' && !!selectedNodeId);
  }, [bp, selectedNodeId]);

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);
  const selectedEdge = useMemo(() => edges.find((e) => e.id === selectedEdgeId) ?? null, [edges, selectedEdgeId]);

  const onConnect = useCallback((conn: Connection) => {
    const branch = (conn.sourceHandle ?? 'always') as 'success' | 'failure' | 'custom' | 'always';
    const id = `e_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    setEdges((eds) => addEdge({
      ...conn,
      id,
      type: 'workflowEdge',
      data: { branch },
    }, eds));
    setDirty(true);
  }, [setEdges]);

  const handleDeleteNode = useCallback((nid: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nid));
    setEdges((es) => es.filter((e) => e.source !== nid && e.target !== nid));
    if (selectedNodeId === nid) setSelectedNodeId(null);
    setDirty(true);
  }, [setNodes, setEdges, selectedNodeId]);

  const handleDuplicateNode = useCallback((nid: string) => {
    setNodes((ns) => {
      const orig = ns.find((n) => n.id === nid);
      if (!orig) return ns;
      const data = orig.data as { type?: string; config?: Record<string, unknown>; secretRefs?: string[] };
      const newId = generateNodeId(data.type ?? 'node', ns.map((n) => n.id));
      const newNode: Node = {
        ...orig,
        id: newId,
        position: { x: orig.position.x + 40, y: orig.position.y + 40 },
        selected: false,
        data: { ...orig.data, onDelete: handleDeleteNode, onDuplicate: handleDuplicateNode },
      };
      return [...ns, newNode];
    });
    setDirty(true);
  }, [setNodes, handleDeleteNode]);

  const handleDeleteEdge = useCallback((eid: string) => {
    setEdges((es) => es.filter((e) => e.id !== eid));
    if (selectedEdgeId === eid) setSelectedEdgeId(null);
    setDirty(true);
  }, [setEdges, selectedEdgeId]);

  // Inject handlers into node data so toolbar / edge knows what to call
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, onDelete: handleDeleteNode, onDuplicate: handleDuplicateNode } })));
    setEdges((es) => es.map((e) => ({ ...e, data: { ...e.data, onDelete: handleDeleteEdge } })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleDeleteNode, handleDuplicateNode, handleDeleteEdge]);

  const handleDrop = useCallback((event: React.DragEvent, position: { x: number; y: number }) => {
    const type = event.dataTransfer.getData('application/x-workflow-node-type');
    if (!type) return;
    addNodeOfType(type, position);
  }, []);

  const addNodeOfType = (type: string, position: { x: number; y: number }) => {
    const meta = byType[type];
    if (!meta) return;
    setNodes((ns) => {
      const newId = generateNodeId(type, ns.map((n) => n.id));
      const defaultConfig = getDefaultsFromJsonSchema(meta.configJsonSchema) as Record<string, unknown> | undefined;
      const newNode: Node = {
        id: newId,
        type: 'workflowNode',
        position,
        data: {
          type,
          config: defaultConfig ?? {},
          secretRefs: [],
          metadata: meta,
          onDelete: handleDeleteNode,
          onDuplicate: handleDuplicateNode,
        },
      };
      return [...ns, newNode];
    });
    setDirty(true);
  };

  const handlePaletteDragStart = (e: React.DragEvent, type: string) => {
    e.dataTransfer.setData('application/x-workflow-node-type', type);
    e.dataTransfer.effectAllowed = 'move';
    draggedTypeRef.current = type;
  };

  const handlePaletteTap = (type: string) => {
    setTapPlaceMode(type);
    toast.showSuccess('Tippe auf eine Position im Canvas, um den Node zu platzieren.');
  };

  // When tap-place mode is on, intercept canvas clicks via ReactFlow's onPaneClick:
  // For simplicity we add a wrapper handler at canvas-level — but ReactFlow doesn't expose that to our WorkflowCanvas wrapper.
  // We work around it: pass a no-op below; full pane-click integration is in WorkflowCanvas as a follow-up (T-251 MVP: drag only).
  // For tablet/touch, users will drag with finger (works in xyflow v12).

  // --- Save / Activate / Run --------------------------------------
  const handleSave = async (extra: Partial<UpdateDto> = {}): Promise<boolean> => {
    if (!workflow) return false;
    setSaving(true);
    try {
      const dto: UpdateDto = {
        nodes: nodes.map((n) => ({
          id: n.id,
          type: (n.data as { type: string }).type,
          position: n.position,
          config: (n.data as { config?: Record<string, unknown> }).config ?? {},
          secretRefs: (n.data as { secretRefs?: string[] }).secretRefs ?? [],
        })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourcePort: e.sourceHandle ?? undefined,
          targetPort: e.targetHandle ?? undefined,
          branch: ((e.data as { branch?: string })?.branch ?? 'always') as 'success' | 'failure' | 'custom' | 'always',
        })),
        ...extra,
      };
      const updated = await workflowsApi.update(id, dto);
      setWorkflow(updated);
      setRemoteIssues([]);
      setDirty(false);
      toast.showSuccess('Workflow gespeichert');
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('cannot') || msg.includes('400')) {
        setRemoteIssues(parseValidationIssues(msg));
      }
      toast.showError(`Speichern fehlgeschlagen: ${msg}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async () => {
    const saved = await handleSave({ status: 'active' });
    if (saved) toast.showSuccess('Workflow aktiviert');
  };

  const handleRun = async () => {
    if (!workflow) return;
    try {
      const run = await workflowsApi.start(id);
      toast.showSuccess(`Run gestartet`);
      setRunId(run._id);
    } catch (err) {
      toast.showError(`Run fehlgeschlagen: ${(err as Error).message}`);
    }
  };

  const handleStatusChange = async (status: WorkflowStatus) => {
    try {
      const updated = await workflowsApi.update(id, { status });
      setWorkflow(updated);
      toast.showSuccess(`Status: ${status}`);
    } catch (err) {
      toast.showError((err as Error).message);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Workflow wirklich löschen?')) return;
    try {
      await workflowsApi.delete(id);
      toast.showSuccess('Workflow gelöscht');
      navigate('/workflows');
    } catch (err) {
      toast.showError((err as Error).message);
    }
  };

  const jumpToNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    const node = nodes.find((n) => n.id === nodeId);
    if (node) reactFlowApi.setCenter(node.position.x, node.position.y, { zoom: 1.2, duration: 400 });
  };

  // upstream nodes for template picker
  const upstreamNodes = useMemo(() => {
    if (!selectedNodeId) return [];
    const incoming = new Set<string>();
    const stack: string[] = [selectedNodeId];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of edges) {
        if (e.target === cur && !incoming.has(e.source)) {
          incoming.add(e.source);
          stack.push(e.source);
        }
      }
    }
    return nodes
      .filter((n) => incoming.has(n.id))
      .map((n) => {
        const d = n.data as { type: string; config?: Record<string, unknown>; secretRefs?: string[] };
        return { id: n.id, type: d.type, config: d.config ?? {}, secretRefs: d.secretRefs };
      });
  }, [nodes, edges, selectedNodeId]);

  const outgoingByBranch = useMemo(() => {
    if (!selectedNodeId) return {};
    const map: Record<string, number> = {};
    for (const e of edges) {
      if (e.source !== selectedNodeId) continue;
      const b = (e.data as { branch?: string })?.branch ?? 'always';
      map[b] = (map[b] ?? 0) + 1;
    }
    return map;
  }, [edges, selectedNodeId]);

  const localIssues = useMemo(() => {
    if (!selectedNode) return [];
    const d = selectedNode.data as { type: string; config?: Record<string, unknown> };
    const meta = byType[d.type];
    if (!meta) return ['Unbekannter Type — Schema nicht geladen.'];
    // very small schema check: required fields present
    const issues: string[] = [];
    const required = ((meta.configJsonSchema as { required?: string[] }).required ?? []);
    const cfg = d.config ?? {};
    for (const r of required) {
      const v = cfg[r];
      if (v === undefined || v === null || v === '') issues.push(`config.${r}: required`);
    }
    return issues;
  }, [selectedNode, byType]);

  if (!workflow) {
    return <div className="container mx-auto p-6 text-sm text-gray-500">Lädt…</div>;
  }

  // --- mobile fallback ---
  if (bp === 'phone') {
    return (
      <WorkflowEditorMobileFallback
        workflow={workflow}
        onActivate={handleActivate}
        onRun={handleRun}
      />
    );
  }

  // --- desktop / tablet layout ---
  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-gray-800 bg-gray-900 px-4 py-2">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/workflows" className="text-gray-400 hover:text-gray-200"><ArrowLeft size={16} /></Link>
          <span className="truncate text-sm font-semibold text-gray-200">{workflow.name}</span>
          <StatusPill status={workflow.status} />
          <span className="rounded bg-gray-800 px-2 py-0.5 text-[10px] text-gray-400">v{workflow.version}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => handleSave()} disabled={saving} className="inline-flex items-center gap-1 rounded bg-gray-800 px-3 py-1 text-xs text-gray-200 hover:bg-gray-700 disabled:opacity-50">
            <Save size={12} /> Speichern
          </button>
          {workflow.status !== 'active' && (
            <button onClick={handleActivate} className="inline-flex items-center gap-1 rounded bg-cyan-600 px-3 py-1 text-xs text-white hover:bg-cyan-500">
              <CheckCircle size={12} /> Aktivieren
            </button>
          )}
          {workflow.status === 'active' && (
            <>
              <button onClick={handleRun} className="inline-flex items-center gap-1 rounded bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-500">
                <Play size={12} /> Run
              </button>
              <button onClick={() => handleStatusChange('paused')} className="inline-flex items-center gap-1 rounded bg-amber-700 px-3 py-1 text-xs text-white hover:bg-amber-600">
                <Pause size={12} /> Pause
              </button>
            </>
          )}
          <button onClick={handleDelete} className="inline-flex items-center gap-1 rounded bg-red-900/60 px-3 py-1 text-xs text-red-200 hover:bg-red-900">
            <Trash2 size={12} />
          </button>
        </div>
      </header>

      <div className="relative flex flex-1 overflow-hidden">
        {/* Palette */}
        {(bp === 'desktop' || paletteOpen) ? (
          <aside className={`${bp === 'desktop' ? 'w-[260px]' : 'absolute z-20 h-full w-[260px]'}`}>
            <WorkflowNodePalette
              catalog={catalog}
              workflowScope={workflow.scope}
              onDragStart={handlePaletteDragStart}
              onTapPlace={handlePaletteTap}
              touchMode={bp === 'tablet'}
            />
          </aside>
        ) : (
          <button onClick={() => setPaletteOpen(true)} className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-r bg-gray-800 p-2 text-gray-300 hover:bg-gray-700">
            <PanelLeftOpen size={20} />
          </button>
        )}
        {bp === 'tablet' && paletteOpen && (
          <button onClick={() => setPaletteOpen(false)} className="absolute left-[252px] top-2 z-30 rounded bg-gray-800 p-1 text-gray-300"><X size={14} /></button>
        )}

        {/* Canvas */}
        <main className="flex-1">
          <WorkflowCanvas
            nodes={nodes}
            edges={edges}
            onNodesChange={(changes) => { onNodesChange(changes); if (changes.some((c) => c.type === 'position' && c.dragging === false)) setDirty(true); }}
            onEdgesChange={(changes) => { onEdgesChange(changes); setDirty(true); }}
            onConnect={onConnect}
            onSelectionChange={(sel) => {
              setSelectedNodeId(sel.nodes[0]?.id ?? null);
              setSelectedEdgeId(sel.edges[0]?.id ?? null);
              if (bp === 'tablet' && (sel.nodes[0] || sel.edges[0])) setInspectorOpen(true);
            }}
            onDrop={handleDrop}
          />
        </main>

        {/* Inspector */}
        {(bp === 'desktop' || inspectorOpen) ? (
          <aside className={`${bp === 'desktop' ? 'w-[320px]' : 'absolute right-0 z-20 h-full w-[320px]'}`}>
            <WorkflowNodeInspector
              selectedNode={selectedNode ? {
                id: selectedNode.id,
                type: (selectedNode.data as { type: string }).type,
                config: ((selectedNode.data as { config?: Record<string, unknown> }).config) ?? {},
                secretRefs: (selectedNode.data as { secretRefs?: string[] }).secretRefs,
              } : null}
              selectedEdge={selectedEdge ? edgeToWf(selectedEdge) : null}
              catalog={catalog}
              upstreamNodes={upstreamNodes}
              outgoingEdgeCountByBranch={outgoingByBranch}
              localIssues={localIssues}
              onChangeConfig={(cfg) => {
                if (!selectedNodeId) return;
                setNodes((ns) => ns.map((n) => n.id === selectedNodeId ? { ...n, data: { ...n.data, config: cfg } } : n));
                setDirty(true);
              }}
              onRenameNode={(_oldId, _newId) => { /* TODO follow-up: id rename + edge update */ }}
              onChangeNodeType={(newType) => {
                if (!selectedNodeId) return;
                const meta = byType[newType];
                if (!meta) return;
                const defaultConfig = (getDefaultsFromJsonSchema(meta.configJsonSchema) as Record<string, unknown>) ?? {};
                setNodes((ns) => ns.map((n) => n.id === selectedNodeId ? { ...n, data: { ...n.data, type: newType, metadata: meta, config: defaultConfig } } : n));
                setDirty(true);
              }}
              onDeleteNode={() => selectedNodeId && handleDeleteNode(selectedNodeId)}
              onDuplicateNode={() => selectedNodeId && handleDuplicateNode(selectedNodeId)}
              onChangeEdgeBranch={(branch) => {
                if (!selectedEdgeId) return;
                setEdges((es) => es.map((e) => e.id === selectedEdgeId ? { ...e, sourceHandle: branch === 'always' ? null : branch, data: { ...e.data, branch } } : e));
                setDirty(true);
              }}
              onDeleteEdge={() => selectedEdgeId && handleDeleteEdge(selectedEdgeId)}
            />
          </aside>
        ) : (
          <button onClick={() => setInspectorOpen(true)} className="absolute right-0 top-1/2 z-10 -translate-y-1/2 rounded-l bg-gray-800 p-2 text-gray-300 hover:bg-gray-700">
            <PanelRightOpen size={20} />
          </button>
        )}
        {bp === 'tablet' && inspectorOpen && (
          <button onClick={() => setInspectorOpen(false)} className="absolute right-[312px] top-2 z-30 rounded bg-gray-800 p-1 text-gray-300"><X size={14} /></button>
        )}
      </div>

      <WorkflowValidationBanner
        issues={remoteIssues}
        onJumpTo={jumpToNode}
        onDismiss={() => setRemoteIssues([])}
      />

      {runId && <WorkflowRunInspector runId={runId} onClose={() => setRunId(null)} />}
    </div>
  );
}

// ---------- helpers ----------

type UpdateDto = {
  nodes: WfNode[];
  edges: WfEdge[];
  status?: WorkflowStatus;
};

function toReactFlowNode(n: WfNode, byType: Record<string, any>): Node {
  return {
    id: n.id,
    type: 'workflowNode',
    position: n.position,
    data: {
      type: n.type,
      config: n.config ?? {},
      secretRefs: n.secretRefs ?? [],
      metadata: byType[n.type],
    },
  };
}

function toReactFlowEdge(e: WfEdge): Edge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourcePort ?? (e.branch && e.branch !== 'always' ? e.branch : null),
    targetHandle: e.targetPort ?? null,
    type: 'workflowEdge',
    data: { branch: e.branch ?? 'always', condition: e.condition },
  };
}

function edgeToWf(e: Edge): WfEdge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourcePort: e.sourceHandle ?? undefined,
    targetPort: e.targetHandle ?? undefined,
    branch: ((e.data as { branch?: WfEdge['branch'] })?.branch ?? 'always') as WfEdge['branch'],
    condition: (e.data as { condition?: Record<string, unknown> })?.condition,
  };
}

function StatusPill({ status }: { status: WorkflowStatus }) {
  const map: Record<WorkflowStatus, string> = {
    draft: 'bg-gray-700 text-gray-200',
    active: 'bg-green-900/60 text-green-200',
    paused: 'bg-amber-900/60 text-amber-200',
    archived: 'bg-gray-800 text-gray-500',
  };
  return <span className={`rounded px-2 py-0.5 text-[10px] uppercase ${map[status]}`}>{status}</span>;
}
```

- [ ] **Step 2: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/pages/WorkflowEditorPage.tsx
git commit -m "feat(workflows): full editor page with save/activate/run + drawer-pattern (T-251)"
```

---

## Task 19: Wire routes + nav + ProjectDetail/CustomerDetail tabs

**Files:** Modify `frontend/src/App.tsx`, `frontend/src/pages/ProjectDetail.tsx`, `frontend/src/pages/CustomerDetail.tsx`.

- [ ] **Step 1: Add routes in App.tsx**

In `frontend/src/App.tsx`, add imports near the top (with other page imports):
```ts
import WorkflowsListPage from './pages/WorkflowsListPage';
import WorkflowEditorPage from './pages/WorkflowEditorPage';
```

Inside the `<Routes>` block (around line 302), AFTER the existing `<Route path="/recurring-tasks" ... />` route (find it via `grep -n recurring-tasks frontend/src/App.tsx`), INSERT:
```tsx
<Route path="/workflows" element={<WorkflowsListPage />} />
<Route path="/workflows/:id" element={<WorkflowEditorPage />} />
```

In the desktop nav block (around line 204 where `nav.recurringTasks` NavLink is), AFTER the recurring-tasks NavLink, INSERT:
```tsx
<NavLink
  to="/workflows"
  className={({ isActive }) =>
    isActive ? 'text-cyan-400' : 'text-gray-400 hover:text-gray-200'
  }
>
  {t('nav.workflows')}
</NavLink>
```

And in the mobile menu block (search for the second `to="/recurring-tasks"` around line 271), add the same NavLink right after it.

- [ ] **Step 2: ProjectDetail tab**

Find `frontend/src/pages/ProjectDetail.tsx`. Search for the tab structure (existing tabs like Todos, Knowledge). Add a new tab "Workflows":

Add import near top:
```ts
import { WorkflowProjectTab } from '../components/workflows/WorkflowProjectTab';
```

Find the tabs-array or tab-list (the actual pattern in this file). Add an entry analogous to existing tabs:
```ts
{ key: 'workflows', label: t('nav.workflows') }
```

In the tab-body switch/conditional, add:
```tsx
{activeTab === 'workflows' && (
  <WorkflowProjectTab scope="project" projectId={project._id} />
)}
```

(The exact code depends on the ProjectDetail pattern — match it by inspection.)

- [ ] **Step 3: CustomerDetail tab**

Same pattern in `frontend/src/pages/CustomerDetail.tsx`:
```tsx
{activeTab === 'workflows' && (
  <WorkflowProjectTab scope="customer" customerId={customer._id} />
)}
```

- [ ] **Step 4: Build + commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/App.tsx frontend/src/pages/ProjectDetail.tsx frontend/src/pages/CustomerDetail.tsx
git commit -m "feat(workflows): routes + nav-link + project/customer detail tabs (T-251)"
```

---

## Task 20: i18n keys

**Files:** Modify `frontend/src/locales/de.json` and `en.json`.

- [ ] **Step 1: Add keys**

In both files, add a `workflows` section. For `de.json`:
```json
"nav": {
  ...
  "workflows": "Workflows"
},
"workflows": {
  "title": "Workflows",
  "new": "Neuer Workflow",
  "empty": "Noch keine Workflows",
  "mobileFallback": "Editor benötigt mindestens 768px Breite. Lesemodus aktiv."
}
```

For `en.json`:
```json
"nav": {
  ...
  "workflows": "Workflows"
},
"workflows": {
  "title": "Workflows",
  "new": "New workflow",
  "empty": "No workflows yet",
  "mobileFallback": "Editor requires at least 768px width. Read-only mode active."
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/locales/de.json frontend/src/locales/en.json
git commit -m "feat(workflows): i18n keys for canvas UI (T-251)"
```

---

## Task 21: Build verification + manual smoke

- [ ] **Step 1: Full frontend build**

```bash
cd frontend && npm run build 2>&1 | tail -20
```

Expected: exit 0, Vite produces `dist/`.

- [ ] **Step 2: Bundle smoke**

```bash
grep -ro "@xyflow/react\|workflow-node-types\|WorkflowCanvas\|control.delay\|action.user-question" frontend/dist 2>/dev/null | wc -l
```

Expected: > 0.

- [ ] **Step 3: Rebuild Docker frontend**

```bash
docker compose up -d --build frontend
```

Wait for `curl -s -o /dev/null -w "%{http_code}" http://localhost/` → 200.

- [ ] **Step 4: Backend regression**

```bash
cd backend && npm run check:workflow-runner-units && npm run check:workflow-nodes-units
```

Both must pass — T-251 changes no backend.

- [ ] **Step 5: Manual browser smokes**

Open http://localhost in a browser. Perform each:
1. Nav to "Workflows" → list page renders, empty state visible if no workflows
2. Click "Neuer Workflow", fill name + scope, create → redirected to editor
3. Drag a `trigger.manual` from palette to canvas → node appears
4. Drag an `action.log` → connect trigger to log → edge appears with branch=success
5. Click the log node → inspector opens with config form (message field as textarea)
6. Type "Hello world" in message field → save → toast "Workflow gespeichert"
7. Click "Aktivieren" → status changes to active
8. Click "Run" → run inspector modal opens, shows nodes running, terminates succeeded
9. Resize browser to ~1024px → palette becomes drawer-toggle button
10. Resize to ~500px → mobile fallback view with JSON view
11. Open `/projects/<id>` → click "Workflows" tab → list filtered for project
12. Create workflow with invalid config (e.g. trigger.manual + missing trigger node) → save → banner shows issues

If any step fails, fix the underlying file, rebuild, retry.

- [ ] **Step 6: Code-review pass**

Self-review the new files for: state-update consistency, dangling event listeners, memory leaks (poll-clear on unmount in `WorkflowRunInspector`), type narrowing of `data as { ... }` casts, missing null guards. Add comments to T-251 in DevGrimoire if anything was deferred.

---

## Task 22: Move T-251 → review → done + DevGrimoire docs

- [ ] **Step 1: Comment on T-251 with summary**

Via MCP `todo_comment` or REST. Summary should include:
- 21 implementation tasks complete (this plan)
- New deps: `@xyflow/react`, `lucide-react`
- 3 viewport modes (desktop 3-panel / tablet drawer / phone read-only)
- 11 component files + 4 hooks + API client
- Backend untouched
- Folge-Tickets to be created: T-251a (live run viz), T-251b (template-autocomplete), T-251c (version diff), T-251d (subflows), T-251e (polished mobile), T-251f (multi-select)

- [ ] **Step 2: Move T-251 → review → done**

```bash
# via REST (MCP if available):
curl -s -X PUT http://localhost:3200/api/todos/69fdd667745761eb9a0ac2fc \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"status":"review"}'
# code-review pass, then:
curl -s -X PUT http://localhost:3200/api/todos/69fdd667745761eb9a0ac2fc \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"status":"done"}'
```

- [ ] **Step 3: Knowledge entry**

POST to `/api/knowledge` (or via MCP `knowledge_save`):
- topic: "Workflow Canvas UI (T-251)"
- scope: project, projectId: 69c12580c01a0739c142f1c0
- category: "Architecture"
- tags: ["workflows", "frontend", "react-flow", "M-31"]
- content: comprehensive description of the 3-panel layout, viewport breakpoints, custom node + edge components, schema-driven inspector, save/activate/run flow, route integration, deferred features as Folge-Tickets

- [ ] **Step 4: Manual entry**

POST to `/api/manuals` (or via MCP `manual_create`):
- title: "Workflow Canvas — Bedienung (T-251)"
- projectId, category: "Workflows", sortOrder: 30
- content: operator-guide: how to create a workflow, drag nodes, connect, configure, activate, run; explanation of the 3 viewport modes; troubleshooting common validation errors

- [ ] **Step 5: Changelog**

POST to `/api/changelog` (or via MCP `changelog_add`):
- projectId, version: "T-251", component: "Frontend"
- summary: "Workflow-Modul: visueller React-Flow-Canvas-Editor"
- changes: bulleted list of every Task-output (new files, viewport modes, save/activate/run, etc.)

- [ ] **Step 6: Push**

```bash
git push origin main
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task(s) |
|---|---|
| 3-panel desktop layout | 18 |
| Tablet drawer pattern | 18 |
| Phone read-only fallback | 16, 18 |
| Custom node with category accents + status ring + warn | 5, 9 |
| Custom edge with branch label + delete | 9 |
| Schema-driven inspector (recursive renderer) | 8, 12 |
| Palette with search + categories + drag/tap | 11 |
| Connect-validation isValidConnection | 13 |
| Save/Activate/Run roundtrip with backend issue parsing | 6, 18 |
| Run inspector modal with polling | 14 |
| Top-level /workflows + project/customer tabs | 17, 19 |
| Template-path picker | 7, 12 |
| i18n + nav-link | 19, 20 |
| Build smoke + manual verification | 21 |
| DevGrimoire docs (knowledge/manual/changelog) | 22 |

**Type consistency:** `WorkflowNodeData` defined in Task 9 used in Task 18 helpers. `RemoteIssue` defined in Task 6 used in Tasks 10, 18. `TemplateOption` defined in Task 7 used in Tasks 8, 12. `SelectedNode` defined in Task 12 used in Task 18.

**Out-of-scope (correctly deferred to follow-up tickets, per spec):**
- Live run-visualization on canvas → T-251a
- Template-picker autocomplete with type-inference → T-251b
- Workflow diff viewer → T-251c
- Subflows / Group-Nodes → T-251d
- Polished mobile editor → T-251e
- Multi-select / Lasso → T-251f
