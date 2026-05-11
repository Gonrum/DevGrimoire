# Workflow Runner / Scheduler Implementation Plan (T-250)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an execution engine + scheduler to the existing workflow module so workflows actually run, with persistence, retry, resume, and a minimal node catalog (manual, schedule, log, todo-create, notify).

**Architecture:** Worker-pool engine pulls node-jobs from an in-memory queue backed by MongoDB; `@Cron(EVERY_MINUTE)` scheduler creates runs from cron/interval triggers with catch-up. Definition-locks serialize runs of the same workflow. Resume uses the existing `question` entity via `@OnEvent`. Crash-recovery on `onModuleInit` rehydrates queued/running runs.

**Tech Stack:** NestJS, Mongoose, `@nestjs/event-emitter`, `@nestjs/schedule`, `cron-parser` (new dep), TypeScript. Verification via `.cjs` check scripts following the existing `check:rag-schema` / `check:workspace-roots-guard` convention.

**Reference spec:** [`docs/workflow-runner.md`](workflow-runner.md)

---

## File Map

**New files:**
- `backend/src/workflows/engine/types.ts` — shared interfaces: `NodeResult`, `NodeExecutionContext`, `NodeExecutor`, `NodeJob`, `RetryConfig`, `TriggerConfig`
- `backend/src/workflows/engine/node-registry.ts` — `NodeRegistry` provider; `register/get/list`
- `backend/src/workflows/engine/graph-walker.ts` — pure helpers `nextNodes(node, branch, def)`, `findTriggerNodes(def)`
- `backend/src/workflows/engine/scheduler-helpers.ts` — pure helpers `computeNext(trigger, now)`, `computeMissedSlots(lastRunAt, now, trigger, maxCatchUp)`
- `backend/src/workflows/engine/workflow-queue.service.ts` — in-memory queue + DB recovery, definition-locks
- `backend/src/workflows/engine/workflow-worker.pool.ts` — N workers, run loop, timeout, retry-backoff
- `backend/src/workflows/engine/workflow-engine.service.ts` — orchestrator: starts queue/pool on boot, lifecycle transitions, resume-on-question, `retryRun`
- `backend/src/workflows/engine/workflow-scheduler.service.ts` — `@Cron(EVERY_MINUTE)` tick, creates runs
- `backend/src/workflows/nodes/trigger-manual.executor.ts`
- `backend/src/workflows/nodes/trigger-schedule.executor.ts`
- `backend/src/workflows/nodes/action-log.executor.ts`
- `backend/src/workflows/nodes/action-todo-create.executor.ts`
- `backend/src/workflows/nodes/action-notify.executor.ts`
- `backend/src/workflows/nodes/template.ts` — pure `expandTemplate(str, ctx)` for `{{context.nodes.x.y}}` interpolation
- `backend/scripts/workflow-runner-units-check.cjs` — pure-logic unit check
- `backend/scripts/workflow-engine-check.cjs` — HTTP-based integration check

**Modified files:**
- `backend/src/workflows/schemas/workflow-definition.schema.ts` — add `nextRunAt`, `lastRunAt`, new index on `(trigger.type, status, nextRunAt)`
- `backend/src/workflows/schemas/workflow-run.schema.ts` — add `context`, `triggeredBy`, sparse-unique index on `(definitionId, triggeredBy.scheduleSlotAt)`
- `backend/src/workflows/schemas/workflow-node-run.schema.ts` — add `waitingFor`, add `INTERRUPTED` enum value
- `backend/src/workflows/dto/workflow.dto.ts` — extend `StartWorkflowRunDto` with `triggeredBy`; new `RetryWorkflowRunDto { fromNodeId? }`; typed `TriggerConfigDto` (manual | schedule)
- `backend/src/workflows/workflows.service.ts` — add `retryRun(id, fromNodeId?)`; in `startRun` honor `dto.triggeredBy`; emit `workflow.run.queued` after create
- `backend/src/workflows/workflows.controller.ts` — `POST /runs/:id/retry`, body `RetryWorkflowRunDto`
- `backend/src/workflows/workflows.module.ts` — register all engine providers + nodes, import `TodosModule`, `NotificationsModule`, `QuestionsModule`, `ScheduleModule`, `EventEmitterModule`
- `backend/src/mcp-tools.ts` — add `workflow_run_retry`
- `backend/package.json` — add `cron-parser` dep; scripts `check:workflow-runner-units`, `check:workflow-engine`

---

## Task 1: Add cron-parser dependency and confirm build

**Files:** `backend/package.json`

- [ ] **Step 1: Install cron-parser**

```bash
cd backend && npm install cron-parser@^4
```

Expected: `package.json` gains `"cron-parser": "^4.x.x"` in `dependencies`, lockfile updated.

- [ ] **Step 2: Smoke-test the import**

```bash
cd backend && node -e "const cp = require('cron-parser'); const it = cp.parseExpression('*/5 * * * *'); console.log(it.next().toISOString());"
```

Expected: ISO timestamp 5 minutes in the future printed, exit 0.

- [ ] **Step 3: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "chore(workflows): add cron-parser dep for scheduler (T-250)"
```

---

## Task 2: Extend schemas (definition, run, node-run)

**Files:**
- Modify: `backend/src/workflows/schemas/workflow-definition.schema.ts`
- Modify: `backend/src/workflows/schemas/workflow-run.schema.ts`
- Modify: `backend/src/workflows/schemas/workflow-node-run.schema.ts`

- [ ] **Step 1: Add `nextRunAt` / `lastRunAt` to WorkflowDefinition**

Edit `workflow-definition.schema.ts` — add inside `WorkflowDefinition` class, before `createdAt?: Date;`:

```ts
  @Prop()
  nextRunAt?: Date;

  @Prop()
  lastRunAt?: Date;
```

And after the existing indexes at file bottom, add:

```ts
WorkflowDefinitionSchema.index({ 'trigger.type': 1, status: 1, nextRunAt: 1 });
```

- [ ] **Step 2: Add `context` + `triggeredBy` to WorkflowRun**

Edit `workflow-run.schema.ts` — add inside `WorkflowRun` class before `createdAt?: Date;`:

```ts
  @Prop({ type: Object, default: () => ({ nodes: {} }) })
  context: Record<string, unknown>;

  @Prop({ type: Object })
  triggeredBy?: {
    type: 'manual' | 'schedule' | 'event';
    scheduleSlotAt?: Date;
    userId?: string;
  };
```

And after existing indexes add:

```ts
WorkflowRunSchema.index(
  { definitionId: 1, 'triggeredBy.scheduleSlotAt': 1 },
  { unique: true, sparse: true, name: 'uniq_run_per_schedule_slot' },
);
```

- [ ] **Step 3: Add `waitingFor` + `INTERRUPTED` to WorkflowNodeRun**

Edit `workflow-node-run.schema.ts` — add `INTERRUPTED = 'interrupted'` to `WorkflowNodeRunStatus` enum (after `RETRYING`). Add inside class before `durationMs?: number;`:

```ts
  @Prop({ type: Object })
  waitingFor?: { type: 'question'; refId: Types.ObjectId };
```

- [ ] **Step 4: Build & verify no compile errors**

```bash
cd backend && npm run build
```

Expected: build succeeds, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/workflows/schemas/
git commit -m "feat(workflows): schema fields for runner (context, triggeredBy, waitingFor, schedule timestamps) (T-250)"
```

---

## Task 3: Engine type definitions

**Files:** Create `backend/src/workflows/engine/types.ts`

- [ ] **Step 1: Write the type module**

```ts
import { Types } from 'mongoose';
import { WorkflowDefinition, WorkflowNode } from '../schemas/workflow-definition.schema';
import { WorkflowRun } from '../schemas/workflow-run.schema';
import { WorkflowNodeRun } from '../schemas/workflow-node-run.schema';

export interface RetryConfig {
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier?: number;
}

export interface ManualTriggerConfig {
  type: 'manual';
}

export interface ScheduleTriggerConfig {
  type: 'schedule';
  cron?: string;
  intervalMinutes?: number;
  timezone?: string;
  maxCatchUp?: number;
}

export type TriggerConfig = ManualTriggerConfig | ScheduleTriggerConfig;

export interface NodeResult {
  status: 'success' | 'failed' | 'waiting';
  output?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
  branch?: 'success' | 'failure' | 'custom';
  waitingFor?: { type: 'question'; refId: Types.ObjectId };
}

export interface NodeLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface NodeExecutionContext {
  run: WorkflowRun & { _id: Types.ObjectId };
  nodeRun: WorkflowNodeRun & { _id: Types.ObjectId };
  node: WorkflowNode;
  config: Record<string, unknown>;
  secretRefs: string[];
  runContext: Record<string, unknown>;
  logger: NodeLogger;
  /** Creates a question record and returns its id. Caller must subsequently
   *  return `{ status: 'waiting', waitingFor: { type: 'question', refId } }`. */
  askUser(question: string, options?: string[]): Promise<{ refId: Types.ObjectId }>;
}

export interface NodeExecutor {
  readonly type: string;
  execute(ctx: NodeExecutionContext): Promise<NodeResult>;
}

export interface NodeJob {
  runId: string;
  nodeRunId: string;
  definitionId: string;
  nodeId: string;
  nodeType: string;
  attempt: number;
}
```

- [ ] **Step 2: Build**

```bash
cd backend && npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add backend/src/workflows/engine/types.ts
git commit -m "feat(workflows): engine type definitions (T-250)"
```

---

## Task 4: Node registry

**Files:** Create `backend/src/workflows/engine/node-registry.ts`

- [ ] **Step 1: Write the registry**

```ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NodeExecutor } from './types';

@Injectable()
export class NodeRegistry {
  private readonly logger = new Logger(NodeRegistry.name);
  private readonly executors = new Map<string, NodeExecutor>();

  register(executor: NodeExecutor): void {
    if (this.executors.has(executor.type)) {
      this.logger.warn(`Overwriting executor for type "${executor.type}"`);
    }
    this.executors.set(executor.type, executor);
  }

  get(type: string): NodeExecutor {
    const exec = this.executors.get(type);
    if (!exec) {
      throw new NotFoundException(`No executor registered for node type "${type}"`);
    }
    return exec;
  }

  has(type: string): boolean {
    return this.executors.has(type);
  }

  list(): string[] {
    return [...this.executors.keys()].sort();
  }
}
```

- [ ] **Step 2: Build**

```bash
cd backend && npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add backend/src/workflows/engine/node-registry.ts
git commit -m "feat(workflows): node registry (T-250)"
```

---

## Task 5: Graph walker (pure helpers)

**Files:** Create `backend/src/workflows/engine/graph-walker.ts`

- [ ] **Step 1: Write the module**

```ts
import { WorkflowEdge, WorkflowNode } from '../schemas/workflow-definition.schema';

interface GraphSnapshot {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** All trigger nodes (type starts with "trigger.") in deterministic id order. */
export function findTriggerNodes(def: GraphSnapshot): WorkflowNode[] {
  return def.nodes
    .filter((n) => n.type.startsWith('trigger.'))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Successors of `nodeId` along edges whose `branch` matches `takenBranch`.
 * An edge without an explicit branch is treated as `'always'` and is included
 * for any takenBranch except `undefined`.
 */
export function nextNodes(
  nodeId: string,
  takenBranch: 'success' | 'failure' | 'custom' | undefined,
  def: GraphSnapshot,
): WorkflowNode[] {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const out: WorkflowNode[] = [];
  for (const edge of def.edges) {
    if (edge.source !== nodeId) continue;
    const branch = edge.branch ?? 'always';
    if (branch !== 'always' && branch !== takenBranch) continue;
    const target = byId.get(edge.target);
    if (target) out.push(target);
  }
  // dedupe (multiple edges may converge)
  const seen = new Set<string>();
  return out.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
}

/** Nodes with no incoming edges (besides trigger nodes). Used by recovery. */
export function findOrphanNodes(def: GraphSnapshot): WorkflowNode[] {
  const hasIncoming = new Set(def.edges.map((e) => e.target));
  return def.nodes.filter((n) => !hasIncoming.has(n.id) && !n.type.startsWith('trigger.'));
}

/** Predecessors of `nodeId` along any branch. */
export function predecessors(nodeId: string, def: GraphSnapshot): string[] {
  return [...new Set(def.edges.filter((e) => e.target === nodeId).map((e) => e.source))];
}
```

- [ ] **Step 2: Build**

```bash
cd backend && npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add backend/src/workflows/engine/graph-walker.ts
git commit -m "feat(workflows): graph-walker pure helpers (T-250)"
```

---

## Task 6: Scheduler helpers (pure)

**Files:** Create `backend/src/workflows/engine/scheduler-helpers.ts`

- [ ] **Step 1: Write the module**

```ts
import { parseExpression } from 'cron-parser';
import { ScheduleTriggerConfig } from './types';

const DEFAULT_MAX_CATCHUP = 1;

/** Next nominal slot strictly after `after`. Throws on invalid trigger. */
export function computeNext(trigger: ScheduleTriggerConfig, after: Date): Date {
  if (trigger.cron) {
    const it = parseExpression(trigger.cron, {
      currentDate: after,
      tz: trigger.timezone,
    });
    return it.next().toDate();
  }
  if (trigger.intervalMinutes && trigger.intervalMinutes > 0) {
    return new Date(after.getTime() + trigger.intervalMinutes * 60_000);
  }
  throw new Error('schedule trigger requires cron or intervalMinutes');
}

/**
 * Returns up to `maxCatchUp` nominal slot times that have already elapsed
 * between `lastRunAt` (exclusive) and `now` (inclusive). When the workflow
 * has never run (`lastRunAt` undefined), returns just the most recent slot
 * up to `now` so the first cron tick fires once and not from the dawn of time.
 */
export function computeMissedSlots(
  lastRunAt: Date | undefined,
  now: Date,
  trigger: ScheduleTriggerConfig,
  maxCatchUp = trigger.maxCatchUp ?? DEFAULT_MAX_CATCHUP,
): Date[] {
  if (maxCatchUp <= 0) return [];

  if (!lastRunAt) {
    // First-ever schedule check: don't backfill, just queue current slot if due.
    const next = computeNext(trigger, new Date(now.getTime() - 1));
    return next <= now ? [next] : [];
  }

  const slots: Date[] = [];
  let cursor = new Date(lastRunAt.getTime());
  while (slots.length < maxCatchUp) {
    const next = computeNext(trigger, cursor);
    if (next > now) break;
    slots.push(next);
    cursor = next;
  }
  // If we hit the cap but more slots remain, the *latest* slots are most useful
  // — but our walker already yielded the earliest ones. n8n-style catch-up is
  // earliest-first, which is what we want for ordering preservation.
  return slots;
}
```

- [ ] **Step 2: Build**

```bash
cd backend && npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add backend/src/workflows/engine/scheduler-helpers.ts
git commit -m "feat(workflows): scheduler pure helpers (computeNext, computeMissedSlots) (T-250)"
```

---

## Task 7: Template-expansion helper

**Files:** Create `backend/src/workflows/nodes/template.ts`

- [ ] **Step 1: Write helper**

```ts
/**
 * Replace `{{context.path.to.value}}` and `{{node.outputs.x}}`-style
 * placeholders. Unknown paths are left literal so failures surface in
 * downstream nodes rather than silently producing empty strings.
 */
export function expandTemplate(input: string, context: Record<string, unknown>): string {
  return input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, expr: string) => {
    const value = lookup(expr.trim(), context);
    if (value === undefined) return match;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

function lookup(path: string, root: Record<string, unknown>): unknown {
  // Allow optional leading "context." prefix
  const cleaned = path.replace(/^context\./, '');
  const parts = cleaned.split('.');
  let cur: unknown = root;
  for (const part of parts) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Recursively expand all string values in an object. */
export function expandConfig(
  config: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'string') out[k] = expandTemplate(v, context);
    else if (Array.isArray(v))
      out[k] = v.map((item) =>
        typeof item === 'string'
          ? expandTemplate(item, context)
          : item && typeof item === 'object'
            ? expandConfig(item as Record<string, unknown>, context)
            : item,
      );
    else if (v && typeof v === 'object') out[k] = expandConfig(v as Record<string, unknown>, context);
    else out[k] = v;
  }
  return out;
}
```

- [ ] **Step 2: Build**

```bash
cd backend && npm run build
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add backend/src/workflows/nodes/template.ts
git commit -m "feat(workflows): template expansion helper for node configs (T-250)"
```

---

## Task 8: Pure-logic check script (units)

**Files:** Create `backend/scripts/workflow-runner-units-check.cjs`, modify `backend/package.json`

- [ ] **Step 1: Write the check script**

```js
#!/usr/bin/env node
/*
 * Pure-logic regression check for the workflow runner (T-250).
 * Loads compiled helpers from dist/ and exercises them.
 * Run with `npm run check:workflow-runner-units` from backend/ after a build.
 */
const path = require('node:path');
const assert = require('node:assert/strict');

function loadCompiled(rel) {
  const abs = path.resolve(__dirname, '..', 'dist', rel);
  try {
    return require(abs);
  } catch (err) {
    console.error(`Failed to load ${abs}. Run \`npm run build\` first.`);
    console.error(err.message);
    process.exit(2);
  }
}

const { NodeRegistry } = loadCompiled('workflows/engine/node-registry.js');
const graphWalker = loadCompiled('workflows/engine/graph-walker.js');
const scheduler = loadCompiled('workflows/engine/scheduler-helpers.js');
const tmpl = loadCompiled('workflows/nodes/template.js');

let failures = 0;
let total = 0;

function check(label, fn) {
  total += 1;
  try {
    fn();
    console.log(`✓ ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${label}\n    ${err.message || err}`);
  }
}

// ---------- NodeRegistry ----------
check('NodeRegistry registers and retrieves executor', () => {
  const reg = new NodeRegistry();
  const exec = { type: 'x.test', execute: async () => ({ status: 'success' }) };
  reg.register(exec);
  assert.equal(reg.get('x.test'), exec);
  assert.equal(reg.has('x.test'), true);
});

check('NodeRegistry.get on unknown type throws', () => {
  const reg = new NodeRegistry();
  assert.throws(() => reg.get('does.not.exist'));
});

check('NodeRegistry.list returns sorted types', () => {
  const reg = new NodeRegistry();
  reg.register({ type: 'b', execute: async () => ({ status: 'success' }) });
  reg.register({ type: 'a', execute: async () => ({ status: 'success' }) });
  assert.deepEqual(reg.list(), ['a', 'b']);
});

// ---------- graph-walker ----------
const sampleGraph = {
  nodes: [
    { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
    { id: 'a', type: 'action.log', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
    { id: 'b', type: 'action.log', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
    { id: 'c', type: 'action.log', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
  ],
  edges: [
    { id: 'e1', source: 't', target: 'a' },
    { id: 'e2', source: 'a', target: 'b', branch: 'success' },
    { id: 'e3', source: 'a', target: 'c', branch: 'failure' },
  ],
};

check('findTriggerNodes returns trigger nodes only', () => {
  const triggers = graphWalker.findTriggerNodes(sampleGraph);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].id, 't');
});

check('nextNodes filters by branch', () => {
  const succ = graphWalker.nextNodes('a', 'success', sampleGraph);
  assert.deepEqual(succ.map((n) => n.id), ['b']);
  const fail = graphWalker.nextNodes('a', 'failure', sampleGraph);
  assert.deepEqual(fail.map((n) => n.id), ['c']);
});

check('nextNodes treats edge without branch as always', () => {
  const after = graphWalker.nextNodes('t', 'success', sampleGraph);
  assert.deepEqual(after.map((n) => n.id), ['a']);
});

check('nextNodes dedupes when multiple edges converge', () => {
  const graph = {
    nodes: [
      { id: 'a', type: 'x', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
      { id: 'b', type: 'x', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'b', branch: 'success' },
      { id: 'e2', source: 'a', target: 'b', branch: 'always' },
    ],
  };
  const after = graphWalker.nextNodes('a', 'success', graph);
  assert.equal(after.length, 1);
});

// ---------- scheduler-helpers ----------
check('computeNext (interval)', () => {
  const base = new Date('2026-05-11T12:00:00.000Z');
  const next = scheduler.computeNext({ type: 'schedule', intervalMinutes: 5 }, base);
  assert.equal(next.toISOString(), '2026-05-11T12:05:00.000Z');
});

check('computeNext (cron)', () => {
  const base = new Date('2026-05-11T12:00:00.000Z');
  const next = scheduler.computeNext({ type: 'schedule', cron: '*/15 * * * *' }, base);
  assert.equal(next.toISOString(), '2026-05-11T12:15:00.000Z');
});

check('computeNext throws when neither cron nor interval', () => {
  assert.throws(() => scheduler.computeNext({ type: 'schedule' }, new Date()));
});

check('computeMissedSlots respects maxCatchUp', () => {
  const last = new Date('2026-05-11T12:00:00.000Z');
  const now = new Date('2026-05-11T12:30:00.000Z');
  const slots = scheduler.computeMissedSlots(
    last,
    now,
    { type: 'schedule', intervalMinutes: 5, maxCatchUp: 2 },
  );
  assert.equal(slots.length, 2);
  assert.equal(slots[0].toISOString(), '2026-05-11T12:05:00.000Z');
  assert.equal(slots[1].toISOString(), '2026-05-11T12:10:00.000Z');
});

check('computeMissedSlots returns [] if nothing missed', () => {
  const last = new Date('2026-05-11T12:00:00.000Z');
  const now = new Date('2026-05-11T12:03:00.000Z');
  const slots = scheduler.computeMissedSlots(last, now, {
    type: 'schedule',
    intervalMinutes: 5,
  });
  assert.deepEqual(slots, []);
});

check('computeMissedSlots first-ever run does not backfill but fires when due', () => {
  const now = new Date('2026-05-11T12:00:00.000Z');
  const slots = scheduler.computeMissedSlots(undefined, now, {
    type: 'schedule',
    cron: '0 12 * * *',
  });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].toISOString(), '2026-05-11T12:00:00.000Z');
});

// ---------- template ----------
check('expandTemplate replaces simple paths', () => {
  const out = tmpl.expandTemplate('hi {{name}}', { name: 'Anna' });
  assert.equal(out, 'hi Anna');
});

check('expandTemplate replaces nested paths with context prefix', () => {
  const out = tmpl.expandTemplate('id={{context.nodes.x.id}}', {
    nodes: { x: { id: 'abc' } },
  });
  assert.equal(out, 'id=abc');
});

check('expandTemplate leaves unknown paths literal', () => {
  const out = tmpl.expandTemplate('val={{missing.thing}}', {});
  assert.equal(out, 'val={{missing.thing}}');
});

check('expandConfig recurses into objects and arrays', () => {
  const out = tmpl.expandConfig(
    { title: 'T {{x}}', meta: { sub: '{{x}}', list: ['{{x}}', 'static'] } },
    { x: '42' },
  );
  assert.equal(out.title, 'T 42');
  assert.equal(out.meta.sub, '42');
  assert.deepEqual(out.meta.list, ['42', 'static']);
});

// ----------
if (failures > 0) {
  console.error(`\n${failures}/${total} checks failed`);
  process.exit(1);
}
console.log(`\nAll ${total} checks passed`);
```

- [ ] **Step 2: Register npm script**

Open `backend/package.json` and add to `scripts`:

```json
"check:workflow-runner-units": "node scripts/workflow-runner-units-check.cjs"
```

- [ ] **Step 3: Build then run check**

```bash
cd backend && npm run build && npm run check:workflow-runner-units
```

Expected: all checks pass, exit 0.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/workflow-runner-units-check.cjs backend/package.json
git commit -m "test(workflows): pure-logic check script for runner units (T-250)"
```

---

## Task 9: Mini-node executors

**Files:**
- Create: `backend/src/workflows/nodes/trigger-manual.executor.ts`
- Create: `backend/src/workflows/nodes/trigger-schedule.executor.ts`
- Create: `backend/src/workflows/nodes/action-log.executor.ts`
- Create: `backend/src/workflows/nodes/action-todo-create.executor.ts`
- Create: `backend/src/workflows/nodes/action-notify.executor.ts`

- [ ] **Step 1: trigger-manual**

```ts
import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';

@Injectable()
export class TriggerManualExecutor implements NodeExecutor {
  readonly type = 'trigger.manual';
  async execute(_ctx: NodeExecutionContext): Promise<NodeResult> {
    return { status: 'success', output: {} };
  }
}
```

- [ ] **Step 2: trigger-schedule**

```ts
import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';

@Injectable()
export class TriggerScheduleExecutor implements NodeExecutor {
  readonly type = 'trigger.schedule';
  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const slot = ctx.run.triggeredBy?.scheduleSlotAt;
    return {
      status: 'success',
      output: { scheduleSlotAt: slot?.toISOString?.() ?? null },
    };
  }
}
```

- [ ] **Step 3: action-log**

```ts
import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { expandTemplate } from './template';

@Injectable()
export class ActionLogExecutor implements NodeExecutor {
  readonly type = 'action.log';
  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const message = expandTemplate(String(ctx.config.message ?? ''), ctx.runContext);
    const level = (ctx.config.level as string) ?? 'info';
    if (level === 'warn') ctx.logger.warn(message);
    else if (level === 'error') ctx.logger.error(message);
    else ctx.logger.info(message);
    return { status: 'success', output: { message, level } };
  }
}
```

- [ ] **Step 4: action-todo-create**

```ts
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { TodosService } from '../../todos/todos.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { expandConfig } from './template';

@Injectable()
export class ActionTodoCreateExecutor implements NodeExecutor {
  readonly type = 'action.todo-create';
  constructor(private readonly todosService: TodosService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const expanded = expandConfig(ctx.config, ctx.runContext);
    const projectId =
      (expanded.projectId as string | undefined) ??
      (ctx.run.projectId instanceof Types.ObjectId ? ctx.run.projectId.toString() : undefined);
    const customerId =
      (expanded.customerId as string | undefined) ??
      (ctx.run.customerId instanceof Types.ObjectId ? ctx.run.customerId.toString() : undefined);

    const title = String(expanded.title ?? '').trim();
    if (!title) {
      return {
        status: 'failed',
        error: { code: 'invalid_config', message: 'todo-create requires a title' },
      };
    }

    const todo = await this.todosService.create({
      title,
      description: expanded.description as string | undefined,
      priority: expanded.priority as 'low' | 'medium' | 'high' | 'critical' | undefined,
      tags: (expanded.tags as string[]) ?? [],
      milestoneId: expanded.milestoneId as string | undefined,
      projectId,
      customerId,
    });

    return {
      status: 'success',
      output: { todoId: todo._id.toString(), todoNumber: todo.displayNumber ?? null },
    };
  }
}
```

- [ ] **Step 5: action-notify**

```ts
import { Injectable } from '@nestjs/common';
import { NotificationsService } from '../../notifications/notifications.service';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { expandTemplate } from './template';

@Injectable()
export class ActionNotifyExecutor implements NodeExecutor {
  readonly type = 'action.notify';
  constructor(private readonly notificationsService: NotificationsService) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    const title = expandTemplate(String(ctx.config.title ?? ''), ctx.runContext);
    const body = expandTemplate(String(ctx.config.body ?? ''), ctx.runContext);
    if (!title) {
      return {
        status: 'failed',
        error: { code: 'invalid_config', message: 'notify requires a title' },
      };
    }
    const url = ctx.config.url as string | undefined;
    const category = (ctx.config.category as string | undefined) ?? 'workflow';
    const n = await this.notificationsService.create(title, body, url, category);
    return { status: 'success', output: { notificationId: n._id.toString() } };
  }
}
```

- [ ] **Step 6: Build**

```bash
cd backend && npm run build
```

Expected: build succeeds. If a TodosService.create signature mismatch shows up, inspect `backend/src/todos/dto/create-todo.dto.ts` and adjust the call accordingly — do not invent fields.

- [ ] **Step 7: Commit**

```bash
git add backend/src/workflows/nodes/
git commit -m "feat(workflows): mini-node executors (manual, schedule, log, todo-create, notify) (T-250)"
```

---

## Task 10: Queue service with definition-locks

**Files:** Create `backend/src/workflows/engine/workflow-queue.service.ts`

- [ ] **Step 1: Write the queue**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { NodeJob } from './types';

interface InternalJob extends NodeJob {
  /** monotonic enqueue sequence for stable FIFO */
  seq: number;
  /** earliest time this job may be dispatched (for retry backoff) */
  notBefore: number;
}

@Injectable()
export class WorkflowQueueService {
  private readonly logger = new Logger(WorkflowQueueService.name);
  private readonly jobs: InternalJob[] = [];
  private readonly definitionLocks = new Set<string>();
  private seqCounter = 0;
  /** notified when a new job is enqueued or a lock is released */
  private waiters: Array<() => void> = [];

  enqueue(job: NodeJob, delayMs = 0): void {
    const internal: InternalJob = {
      ...job,
      seq: ++this.seqCounter,
      notBefore: Date.now() + delayMs,
    };
    this.jobs.push(internal);
    this.logger.debug(
      `Enqueued ${job.nodeType}#${job.nodeId} (run=${job.runId}, attempt=${job.attempt}, delay=${delayMs}ms, queueSize=${this.jobs.length})`,
    );
    this.signal();
  }

  /** Remove all pending jobs for a run (used on cancel/retry). */
  removeRun(runId: string): number {
    const before = this.jobs.length;
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      if (this.jobs[i].runId === runId) this.jobs.splice(i, 1);
    }
    return before - this.jobs.length;
  }

  /**
   * Pick the next dispatchable job. Returns null if queue empty or all
   * head-of-line jobs are locked / delayed. Does NOT acquire the definition
   * lock — caller does that via `acquireLock`.
   */
  peek(): InternalJob | null {
    const now = Date.now();
    // sort by seq (FIFO); avoid full sort if already ordered by tracking inserts
    this.jobs.sort((a, b) => a.seq - b.seq);
    for (const job of this.jobs) {
      if (job.notBefore > now) continue;
      if (this.definitionLocks.has(job.definitionId)) continue;
      return job;
    }
    return null;
  }

  take(seq: number): NodeJob | null {
    const idx = this.jobs.findIndex((j) => j.seq === seq);
    if (idx === -1) return null;
    const [removed] = this.jobs.splice(idx, 1);
    return removed;
  }

  acquireLock(definitionId: string): boolean {
    if (this.definitionLocks.has(definitionId)) return false;
    this.definitionLocks.add(definitionId);
    return true;
  }

  releaseLock(definitionId: string): void {
    this.definitionLocks.delete(definitionId);
    this.signal();
  }

  size(): number {
    return this.jobs.length;
  }

  lockedDefinitions(): string[] {
    return [...this.definitionLocks];
  }

  /** Resolves on the next signal (new job, released lock) or after `timeoutMs`. */
  wait(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== resolver);
        resolve();
      }, timeoutMs);
      const resolver = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(resolver);
    });
  }

  private signal(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) w();
  }
}
```

- [ ] **Step 2: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/workflows/engine/workflow-queue.service.ts
git commit -m "feat(workflows): in-memory job queue with definition-locks (T-250)"
```

---

## Task 11: Worker pool

**Files:** Create `backend/src/workflows/engine/workflow-worker.pool.ts`

- [ ] **Step 1: Write the pool**

The pool runs N workers; each worker waits for a dispatchable job, asks the engine to run it, then loops. Engine wiring (lifecycle + result handling) lives in Task 12. The pool keeps a callback hook supplied by the engine to avoid a circular import.

```ts
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WorkflowQueueService } from './workflow-queue.service';
import { NodeJob } from './types';

export type JobRunner = (job: NodeJob) => Promise<void>;

const POLL_TIMEOUT_MS = 1000;

@Injectable()
export class WorkflowWorkerPool implements OnModuleDestroy {
  private readonly logger = new Logger(WorkflowWorkerPool.name);
  private runner: JobRunner | null = null;
  private stopped = false;
  private workers: Promise<void>[] = [];

  constructor(private readonly queue: WorkflowQueueService) {}

  setRunner(runner: JobRunner): void {
    this.runner = runner;
  }

  start(concurrency: number): void {
    if (this.workers.length > 0) return;
    this.stopped = false;
    const n = Math.max(1, concurrency);
    this.logger.log(`Starting ${n} workflow worker(s)`);
    for (let i = 0; i < n; i++) this.workers.push(this.loop(i));
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.workers);
    this.workers = [];
  }

  private async loop(idx: number): Promise<void> {
    while (!this.stopped) {
      if (!this.runner) {
        await this.queue.wait(POLL_TIMEOUT_MS);
        continue;
      }
      const head = this.queue.peek();
      if (!head) {
        await this.queue.wait(POLL_TIMEOUT_MS);
        continue;
      }
      if (!this.queue.acquireLock(head.definitionId)) {
        await this.queue.wait(POLL_TIMEOUT_MS);
        continue;
      }
      const job = this.queue.take(head.seq);
      if (!job) {
        // raced with another worker; release and retry
        this.queue.releaseLock(head.definitionId);
        continue;
      }
      try {
        await this.runner(job);
      } catch (err) {
        this.logger.error(
          `Worker ${idx} runner threw (run=${job.runId}, node=${job.nodeId}): ${(err as Error).message}`,
        );
      } finally {
        this.queue.releaseLock(job.definitionId);
      }
    }
  }
}
```

- [ ] **Step 2: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/workflows/engine/workflow-worker.pool.ts
git commit -m "feat(workflows): worker pool with definition-lock contention (T-250)"
```

---

## Task 12: Engine service (orchestrator)

**Files:** Create `backend/src/workflows/engine/workflow-engine.service.ts`

This is the largest task. It wires queue ↔ pool, handles node-result transitions, retry-backoff, run termination, recovery, resume-via-question, and exposes `retryRun`. Implement step-by-step; build between steps.

- [ ] **Step 1: Skeleton with constructor + injection + module hooks**

```ts
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ModuleRef } from '@nestjs/core';
import {
  WorkflowDefinition,
  WorkflowDefinitionDocument,
  WorkflowNode,
} from '../schemas/workflow-definition.schema';
import {
  WorkflowRun,
  WorkflowRunDocument,
  WorkflowRunStatus,
} from '../schemas/workflow-run.schema';
import {
  WorkflowNodeRun,
  WorkflowNodeRunDocument,
  WorkflowNodeRunStatus,
} from '../schemas/workflow-node-run.schema';
import { WorkflowQueueService } from './workflow-queue.service';
import { WorkflowWorkerPool } from './workflow-worker.pool';
import { NodeRegistry } from './node-registry';
import { NodeJob, NodeResult, RetryConfig } from './types';
import { findTriggerNodes, nextNodes } from './graph-walker';
import { QuestionsService, QUESTION_ANSWERED } from '../../questions/questions.service';

const DEFAULT_TIMEOUT_MS = 30_000;
const NODE_LOG_CAP = Number(process.env.WORKFLOW_NODE_LOG_CAP ?? 200);
const RECOVERY_AGE_MS = Number(process.env.WORKFLOW_RUN_RECOVERY_AGE_MS ?? 5 * 60_000);
const WORKER_CONCURRENCY = Number(process.env.WORKFLOW_WORKER_CONCURRENCY ?? 4);

@Injectable()
export class WorkflowEngineService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(WorkflowEngineService.name);

  constructor(
    @InjectModel(WorkflowDefinition.name)
    private readonly definitionModel: Model<WorkflowDefinitionDocument>,
    @InjectModel(WorkflowRun.name)
    private readonly runModel: Model<WorkflowRunDocument>,
    @InjectModel(WorkflowNodeRun.name)
    private readonly nodeRunModel: Model<WorkflowNodeRunDocument>,
    private readonly queue: WorkflowQueueService,
    private readonly workerPool: WorkflowWorkerPool,
    private readonly registry: NodeRegistry,
    private readonly eventEmitter: EventEmitter2,
    private readonly questionsService: QuestionsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    this.workerPool.setRunner((job) => this.runJob(job));
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.recoverInterruptedRuns();
    this.workerPool.start(WORKER_CONCURRENCY);
  }
}
```

- [ ] **Step 2: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 3: Add `workflow.run.queued` listener + trigger-node fan-out**

Inside `WorkflowEngineService`, add:

```ts
  @OnEvent('workflow.run.queued')
  async handleRunQueued(payload: { runId: string }): Promise<void> {
    const run = await this.runModel.findById(payload.runId).exec();
    if (!run) return;
    if (run.status !== WorkflowRunStatus.QUEUED) return;
    run.status = WorkflowRunStatus.RUNNING;
    run.startedAt ??= new Date();
    await run.save();

    const snapshot = run.definitionSnapshot as { nodes: WorkflowNode[]; edges: unknown[] };
    const triggers = findTriggerNodes({
      nodes: snapshot.nodes,
      edges: snapshot.edges as never,
    });
    if (triggers.length === 0) {
      await this.failRun(run, { code: 'no_trigger', message: 'No trigger node in graph' });
      return;
    }
    for (const t of triggers) {
      await this.enqueueNode(run, t, 1);
    }
  }

  private async enqueueNode(
    run: WorkflowRunDocument,
    node: WorkflowNode,
    attempt: number,
    delayMs = 0,
  ): Promise<void> {
    const nodeRun = await this.nodeRunModel.create({
      runId: run._id,
      definitionId: run.definitionId,
      definitionVersion: run.definitionVersion,
      nodeId: node.id,
      nodeType: node.type,
      attempt,
      status: WorkflowNodeRunStatus.QUEUED,
    });
    const job: NodeJob = {
      runId: run._id.toString(),
      nodeRunId: nodeRun._id.toString(),
      definitionId: run.definitionId.toString(),
      nodeId: node.id,
      nodeType: node.type,
      attempt,
    };
    this.queue.enqueue(job, delayMs);
  }
```

- [ ] **Step 4: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 5: Add `runJob` (executor invocation + result handling)**

Append to `WorkflowEngineService`:

```ts
  async runJob(job: NodeJob): Promise<void> {
    const run = await this.runModel.findById(job.runId).exec();
    const nodeRun = await this.nodeRunModel.findById(job.nodeRunId).exec();
    if (!run || !nodeRun) return;
    if (run.status !== WorkflowRunStatus.RUNNING) return;

    const snapshot = run.definitionSnapshot as { nodes: WorkflowNode[]; edges: unknown[] };
    const node = snapshot.nodes.find((n) => n.id === job.nodeId);
    if (!node) {
      await this.completeNodeRun(nodeRun, {
        status: 'failed',
        error: { code: 'node_missing', message: `Node ${job.nodeId} not in snapshot` },
      });
      await this.failRun(run, nodeRun.error as never);
      return;
    }

    let executor;
    try {
      executor = this.registry.get(node.type);
    } catch {
      await this.completeNodeRun(nodeRun, {
        status: 'failed',
        error: { code: 'unknown_type', message: `No executor for "${node.type}"` },
      });
      await this.failRun(run, nodeRun.error as never);
      return;
    }

    nodeRun.status = WorkflowNodeRunStatus.RUNNING;
    nodeRun.startedAt = new Date();
    await nodeRun.save();

    const timeoutMs = Number((node.config as Record<string, unknown>).timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const ctx = this.buildContext(run, nodeRun, node);
    let result: NodeResult;
    try {
      result = await this.withTimeout(executor.execute(ctx), timeoutMs);
    } catch (err) {
      result = {
        status: 'failed',
        error: {
          code: (err as Error).name === 'TimeoutError' ? 'timeout' : 'executor_threw',
          message: (err as Error).message,
        },
      };
    }

    await this.applyResult(run, nodeRun, node, result);
  }

  private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, rej) => {
          timer = setTimeout(() => {
            const e = new Error(`node exceeded ${ms}ms`);
            e.name = 'TimeoutError';
            rej(e);
          }, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private buildContext(run: WorkflowRunDocument, nodeRun: WorkflowNodeRunDocument, node: WorkflowNode) {
    const logs: Array<Record<string, unknown>> = nodeRun.logs;
    const append = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => {
      logs.push({ at: new Date().toISOString(), level, msg, ...(data ?? {}) });
      while (logs.length > NODE_LOG_CAP) logs.shift();
    };
    return {
      run: run.toObject() as never,
      nodeRun: nodeRun.toObject() as never,
      node,
      config: (node.config as Record<string, unknown>) ?? {},
      secretRefs: node.secretRefs ?? [],
      runContext: run.context ?? { nodes: {} },
      logger: {
        info: (m: string, d?: Record<string, unknown>) => append('info', m, d),
        warn: (m: string, d?: Record<string, unknown>) => append('warn', m, d),
        error: (m: string, d?: Record<string, unknown>) => append('error', m, d),
      },
      askUser: async (q: string, options?: string[]) => {
        const projectId =
          run.projectId instanceof Types.ObjectId ? run.projectId.toString() : undefined;
        const question = await this.questionsService.create({
          question: q,
          options: options ?? [],
          projectId,
          direction: 'agent_to_user',
          agentName: 'workflow',
          agentRunId: run._id.toString(),
        });
        return { refId: question._id };
      },
    };
  }
```

- [ ] **Step 6: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 7: Add result-application (success / failed / waiting + retry)**

Append:

```ts
  private async applyResult(
    run: WorkflowRunDocument,
    nodeRun: WorkflowNodeRunDocument,
    node: WorkflowNode,
    result: NodeResult,
  ): Promise<void> {
    if (result.status === 'success') {
      await this.completeNodeRun(nodeRun, result);
      const ctx = (run.context as { nodes: Record<string, unknown> }) ?? { nodes: {} };
      ctx.nodes = ctx.nodes ?? {};
      ctx.nodes[node.id] = result.output ?? {};
      run.context = ctx;
      await run.save();

      const snapshot = run.definitionSnapshot as { nodes: WorkflowNode[]; edges: unknown[] };
      const succs = nextNodes(
        node.id,
        result.branch ?? 'success',
        { nodes: snapshot.nodes, edges: snapshot.edges as never },
      );
      for (const succ of succs) await this.enqueueNode(run, succ, 1);
      await this.maybeFinishRun(run);
      return;
    }

    if (result.status === 'waiting') {
      nodeRun.status = WorkflowNodeRunStatus.WAITING;
      nodeRun.waitingFor = result.waitingFor;
      await nodeRun.save();
      run.status = WorkflowRunStatus.WAITING_FOR_USER;
      await run.save();
      return;
    }

    // failed
    const retry = (node.config as { retry?: RetryConfig }).retry;
    const max = retry?.maxAttempts ?? 0;
    if (nodeRun.attempt < max + 1) {
      const base = retry?.backoffMs ?? 1000;
      const mult = retry?.backoffMultiplier ?? 1;
      const delay = base * Math.pow(mult, nodeRun.attempt - 1);
      await this.completeNodeRun(nodeRun, { ...result, status: 'failed' });
      await this.enqueueNode(run, node, nodeRun.attempt + 1, delay);
      return;
    }
    await this.completeNodeRun(nodeRun, result);
    await this.failRun(run, result.error ?? { code: 'failed', message: 'node failed' });
  }

  private async completeNodeRun(nodeRun: WorkflowNodeRunDocument, result: NodeResult): Promise<void> {
    nodeRun.status =
      result.status === 'success'
        ? WorkflowNodeRunStatus.SUCCEEDED
        : result.status === 'waiting'
          ? WorkflowNodeRunStatus.WAITING
          : WorkflowNodeRunStatus.FAILED;
    nodeRun.outputSnapshot = result.output;
    if (result.error) nodeRun.error = result.error;
    nodeRun.finishedAt = new Date();
    if (nodeRun.startedAt)
      nodeRun.durationMs = nodeRun.finishedAt.getTime() - nodeRun.startedAt.getTime();
    await nodeRun.save();
  }

  private async maybeFinishRun(run: WorkflowRunDocument): Promise<void> {
    // run finishes when no NodeRun is in a non-terminal state and no jobs pending
    const openCount = await this.nodeRunModel
      .countDocuments({
        runId: run._id,
        status: { $in: [WorkflowNodeRunStatus.QUEUED, WorkflowNodeRunStatus.RUNNING, WorkflowNodeRunStatus.WAITING, WorkflowNodeRunStatus.RETRYING] },
      })
      .exec();
    if (openCount > 0) return;
    if (run.status === WorkflowRunStatus.WAITING_FOR_USER) return;
    run.status = WorkflowRunStatus.SUCCEEDED;
    run.finishedAt = new Date();
    await run.save();
    this.eventEmitter.emit('workflow.run.finished', { runId: run._id.toString(), status: run.status });
  }

  private async failRun(run: WorkflowRunDocument, error: { code: string; message: string }): Promise<void> {
    this.queue.removeRun(run._id.toString());
    run.status = WorkflowRunStatus.FAILED;
    run.error = error;
    run.finishedAt = new Date();
    await run.save();
    this.eventEmitter.emit('workflow.run.finished', { runId: run._id.toString(), status: run.status });
  }
```

- [ ] **Step 8: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 9: Add question-resume handler + retryRun**

Append:

```ts
  @OnEvent(QUESTION_ANSWERED)
  async handleQuestionAnswered(payload: { questionId: string; answer: string }): Promise<void> {
    const nodeRun = await this.nodeRunModel
      .findOne({
        'waitingFor.type': 'question',
        'waitingFor.refId': new Types.ObjectId(payload.questionId),
        status: WorkflowNodeRunStatus.WAITING,
      })
      .exec();
    if (!nodeRun) return;

    const run = await this.runModel.findById(nodeRun.runId).exec();
    if (!run) return;
    const snapshot = run.definitionSnapshot as { nodes: WorkflowNode[]; edges: unknown[] };
    const node = snapshot.nodes.find((n) => n.id === nodeRun.nodeId);
    if (!node) return;

    nodeRun.waitingFor = undefined;
    run.status = WorkflowRunStatus.RUNNING;
    await run.save();
    await this.applyResult(run, nodeRun, node, {
      status: 'success',
      output: { answer: payload.answer },
    });
  }

  async retryRun(runId: string, fromNodeId?: string): Promise<void> {
    const run = await this.runModel.findById(runId).exec();
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.status !== WorkflowRunStatus.FAILED && run.status !== WorkflowRunStatus.CANCELLED) {
      throw new Error(`retryRun only allowed on failed/cancelled (got ${run.status})`);
    }
    // delete pending node-runs
    await this.nodeRunModel
      .deleteMany({
        runId: run._id,
        status: { $in: [WorkflowNodeRunStatus.QUEUED, WorkflowNodeRunStatus.RUNNING] },
      })
      .exec();

    const snapshot = run.definitionSnapshot as { nodes: WorkflowNode[]; edges: unknown[] };
    let nodeToStart: WorkflowNode | undefined;
    if (fromNodeId) nodeToStart = snapshot.nodes.find((n) => n.id === fromNodeId);
    if (!nodeToStart) {
      // find first failed node
      const failed = await this.nodeRunModel
        .findOne({ runId: run._id, status: WorkflowNodeRunStatus.FAILED })
        .sort({ createdAt: 1 })
        .exec();
      if (failed) nodeToStart = snapshot.nodes.find((n) => n.id === failed.nodeId);
    }
    if (!nodeToStart) nodeToStart = findTriggerNodes({ nodes: snapshot.nodes, edges: snapshot.edges as never })[0];

    run.status = WorkflowRunStatus.QUEUED;
    run.error = undefined;
    run.finishedAt = undefined;
    await run.save();
    if (nodeToStart) await this.enqueueNode(run, nodeToStart, 1);
    this.eventEmitter.emit('workflow.run.queued', { runId: run._id.toString() });
  }
```

- [ ] **Step 10: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 11: Add recovery**

Append:

```ts
  private async recoverInterruptedRuns(): Promise<void> {
    const cutoff = new Date(Date.now() - RECOVERY_AGE_MS);
    const stale = await this.runModel
      .find({ status: WorkflowRunStatus.RUNNING, updatedAt: { $lt: cutoff } })
      .exec();
    for (const run of stale) {
      await this.nodeRunModel
        .updateMany(
          { runId: run._id, status: { $in: [WorkflowNodeRunStatus.RUNNING, WorkflowNodeRunStatus.QUEUED] } },
          { $set: { status: WorkflowNodeRunStatus.INTERRUPTED, finishedAt: new Date() } },
        )
        .exec();
      run.status = WorkflowRunStatus.QUEUED;
      await run.save();
      this.eventEmitter.emit('workflow.run.queued', { runId: run._id.toString() });
      this.logger.warn(`Recovered interrupted run ${run._id.toString()}`);
    }

    // requeue any plain queued runs that lost their event
    const queued = await this.runModel.find({ status: WorkflowRunStatus.QUEUED }).exec();
    for (const run of queued) {
      this.eventEmitter.emit('workflow.run.queued', { runId: run._id.toString() });
    }
  }
```

- [ ] **Step 12: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 13: Commit**

```bash
git add backend/src/workflows/engine/workflow-engine.service.ts
git commit -m "feat(workflows): runner engine — lifecycle, retry, resume, recovery (T-250)"
```

---

## Task 13: Scheduler service

**Files:** Create `backend/src/workflows/engine/workflow-scheduler.service.ts`

- [ ] **Step 1: Write the scheduler**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  WorkflowDefinition,
  WorkflowDefinitionDocument,
  WorkflowStatus,
} from '../schemas/workflow-definition.schema';
import { WorkflowsService } from '../workflows.service';
import { computeMissedSlots, computeNext } from './scheduler-helpers';
import { ScheduleTriggerConfig } from './types';

@Injectable()
export class WorkflowSchedulerService {
  private readonly logger = new Logger(WorkflowSchedulerService.name);
  private readonly definitionLocks = new Set<string>();

  constructor(
    @InjectModel(WorkflowDefinition.name)
    private readonly definitionModel: Model<WorkflowDefinitionDocument>,
    private readonly workflowsService: WorkflowsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (process.env.WORKFLOW_SCHEDULER_DISABLED === 'true') return;
    await this.processDueSchedules(new Date());
  }

  /** Exposed for tests / manual triggering. */
  async processDueSchedules(now: Date): Promise<void> {
    const due = await this.definitionModel
      .find({
        status: WorkflowStatus.ACTIVE,
        'trigger.type': 'schedule',
        $or: [{ nextRunAt: { $lte: now } }, { nextRunAt: { $exists: false } }, { nextRunAt: null }],
      })
      .exec();

    for (const def of due) {
      const id = def._id.toString();
      if (this.definitionLocks.has(id)) continue;
      this.definitionLocks.add(id);
      try {
        await this.processDefinition(def, now);
      } catch (err) {
        this.logger.error(`Scheduler failed for ${def.name}: ${(err as Error).message}`);
      } finally {
        this.definitionLocks.delete(id);
      }
    }
  }

  private async processDefinition(def: WorkflowDefinitionDocument, now: Date): Promise<void> {
    const trigger = def.trigger as unknown as ScheduleTriggerConfig;
    let slots: Date[];
    try {
      slots = computeMissedSlots(def.lastRunAt, now, trigger);
    } catch (err) {
      this.logger.warn(`Invalid schedule trigger on "${def.name}": ${(err as Error).message}`);
      return;
    }

    for (const slot of slots) {
      try {
        await this.workflowsService.startRun({
          definitionId: def._id.toString(),
          triggeredBy: { type: 'schedule', scheduleSlotAt: slot },
        });
      } catch (err) {
        // unique index on (definitionId, triggeredBy.scheduleSlotAt) — duplicate is fine
        const code = (err as { code?: number }).code;
        if (code !== 11000) throw err;
        this.logger.debug(`Skipped duplicate slot ${slot.toISOString()} for ${def.name}`);
      }
    }

    try {
      def.nextRunAt = computeNext(trigger, now);
    } catch {
      def.nextRunAt = undefined;
    }
    def.lastRunAt = now;
    await def.save();
  }
}
```

- [ ] **Step 2: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/workflows/engine/workflow-scheduler.service.ts
git commit -m "feat(workflows): cron-tick scheduler with catch-up (T-250)"
```

---

## Task 14: DTO + service extensions for `triggeredBy` + `retryRun`

**Files:**
- Modify: `backend/src/workflows/dto/workflow.dto.ts`
- Modify: `backend/src/workflows/workflows.service.ts`

- [ ] **Step 1: Extend `StartWorkflowRunDto` and add `RetryWorkflowRunDto`**

Open `backend/src/workflows/dto/workflow.dto.ts`. Find the existing `StartWorkflowRunDto`. Add an optional `triggeredBy` field (object with `type`, optional `scheduleSlotAt` ISO string, optional `userId`). At the end of the file, add:

```ts
export class TriggeredByDto {
  type: 'manual' | 'schedule' | 'event';
  scheduleSlotAt?: string;
  userId?: string;
}

export class RetryWorkflowRunDto {
  fromNodeId?: string;
}
```

Then add `triggeredBy?: TriggeredByDto` to `StartWorkflowRunDto` with the same validator style used for existing optional fields. If the existing DTO uses `class-validator` decorators, follow the same pattern.

- [ ] **Step 2: Update `startRun` in `WorkflowsService` to honor `dto.triggeredBy` and emit event**

Open `backend/src/workflows/workflows.service.ts`. In `startRun`, change the `runModel.create({...})` block to include:

```ts
      triggeredBy: dto.triggeredBy
        ? {
            type: dto.triggeredBy.type,
            scheduleSlotAt: dto.triggeredBy.scheduleSlotAt
              ? new Date(dto.triggeredBy.scheduleSlotAt)
              : undefined,
            userId: dto.triggeredBy.userId,
          }
        : { type: 'manual', userId },
      context: { nodes: {} },
```

And after the existing `this.emitRun('created', ...)` call, add:

```ts
    this.eventEmitter.emit('workflow.run.queued', { runId: run._id.toString() });
```

- [ ] **Step 3: Add `retryRun` to `WorkflowsService`**

This is a thin delegate — the engine owns the logic. Add to `WorkflowsService` (forward-injecting `WorkflowEngineService` would create a cycle; instead expose a public method on the engine and call it via `ModuleRef` or duplicate the method here). To avoid the cycle, expose `retryRun` directly from the engine and update the controller to inject the engine.

Skip this step in this task and handle retry wiring in Task 15 (controller).

- [ ] **Step 4: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/workflows/dto/workflow.dto.ts backend/src/workflows/workflows.service.ts
git commit -m "feat(workflows): DTO+service support for triggeredBy and queued event (T-250)"
```

---

## Task 15: Controller endpoint for retry

**Files:** Modify `backend/src/workflows/workflows.controller.ts`

- [ ] **Step 1: Inject engine and add endpoint**

Open `backend/src/workflows/workflows.controller.ts`. Add to the constructor (alongside `WorkflowsService`):

```ts
    private readonly engine: WorkflowEngineService,
```

Add the import:

```ts
import { WorkflowEngineService } from './engine/workflow-engine.service';
import { RetryWorkflowRunDto } from './dto/workflow.dto';
```

Add the handler — place near the existing `cancelRun` route:

```ts
  @Post('runs/:id/retry')
  async retryRun(@Param('id') id: string, @Body() body: RetryWorkflowRunDto = {}): Promise<{ ok: true }> {
    await this.engine.retryRun(id, body.fromNodeId);
    return { ok: true };
  }
```

- [ ] **Step 2: Build**

```bash
cd backend && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/workflows/workflows.controller.ts
git commit -m "feat(workflows): POST /runs/:id/retry endpoint (T-250)"
```

---

## Task 16: Module wiring

**Files:** Modify `backend/src/workflows/workflows.module.ts`

- [ ] **Step 1: Rewrite the module**

Replace the file content with:

```ts
import { Module, OnModuleInit } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { WorkflowDefinition, WorkflowDefinitionSchema } from './schemas/workflow-definition.schema';
import { WorkflowRun, WorkflowRunSchema } from './schemas/workflow-run.schema';
import { WorkflowNodeRun, WorkflowNodeRunSchema } from './schemas/workflow-node-run.schema';
import { WorkflowEngineService } from './engine/workflow-engine.service';
import { WorkflowQueueService } from './engine/workflow-queue.service';
import { WorkflowWorkerPool } from './engine/workflow-worker.pool';
import { WorkflowSchedulerService } from './engine/workflow-scheduler.service';
import { NodeRegistry } from './engine/node-registry';
import { TriggerManualExecutor } from './nodes/trigger-manual.executor';
import { TriggerScheduleExecutor } from './nodes/trigger-schedule.executor';
import { ActionLogExecutor } from './nodes/action-log.executor';
import { ActionTodoCreateExecutor } from './nodes/action-todo-create.executor';
import { ActionNotifyExecutor } from './nodes/action-notify.executor';
import { TodosModule } from '../todos/todos.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QuestionsModule } from '../questions/questions.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WorkflowDefinition.name, schema: WorkflowDefinitionSchema },
      { name: WorkflowRun.name, schema: WorkflowRunSchema },
      { name: WorkflowNodeRun.name, schema: WorkflowNodeRunSchema },
    ]),
    ScheduleModule.forRoot(),
    TodosModule,
    NotificationsModule,
    QuestionsModule,
  ],
  controllers: [WorkflowsController],
  providers: [
    WorkflowsService,
    WorkflowEngineService,
    WorkflowQueueService,
    WorkflowWorkerPool,
    WorkflowSchedulerService,
    NodeRegistry,
    TriggerManualExecutor,
    TriggerScheduleExecutor,
    ActionLogExecutor,
    ActionTodoCreateExecutor,
    ActionNotifyExecutor,
  ],
  exports: [WorkflowsService, WorkflowEngineService],
})
export class WorkflowsModule implements OnModuleInit {
  constructor(
    private readonly registry: NodeRegistry,
    private readonly triggerManual: TriggerManualExecutor,
    private readonly triggerSchedule: TriggerScheduleExecutor,
    private readonly actionLog: ActionLogExecutor,
    private readonly actionTodo: ActionTodoCreateExecutor,
    private readonly actionNotify: ActionNotifyExecutor,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.triggerManual);
    this.registry.register(this.triggerSchedule);
    this.registry.register(this.actionLog);
    this.registry.register(this.actionTodo);
    this.registry.register(this.actionNotify);
  }
}
```

- [ ] **Step 2: Verify `ScheduleModule` isn't double-imported**

Search:

```bash
grep -rn "ScheduleModule.forRoot" backend/src/ | grep -v node_modules
```

If `ScheduleModule.forRoot()` already exists in `AppModule`, remove it from `WorkflowsModule` to avoid conflict (NestJS allows it, but consolidate). Inspect and decide.

- [ ] **Step 3: Build**

```bash
cd backend && npm run build
```

Expected: build succeeds. If TodosService/NotificationsService/QuestionsService aren't exported from their modules, add them to the `exports:` of those modules (smallest possible change).

- [ ] **Step 4: Commit**

```bash
git add backend/src/workflows/workflows.module.ts
# only add downstream exports if you had to touch them:
# git add backend/src/todos/todos.module.ts backend/src/notifications/notifications.module.ts backend/src/questions/questions.module.ts
git commit -m "feat(workflows): wire engine, scheduler, nodes in module (T-250)"
```

---

## Task 17: MCP tool for retry

**Files:** Modify `backend/src/mcp-tools.ts`

- [ ] **Step 1: Locate the existing workflow tools section**

```bash
grep -n "workflow_run_cancel\|workflow_run_start" backend/src/mcp-tools.ts | head -5
```

Use those line numbers as reference for matching style. Then add `workflow_run_retry` next to `workflow_run_cancel` using the same registration pattern (zod schema, handler delegating to `WorkflowEngineService.retryRun`). Match field names and error semantics of the existing tools.

- [ ] **Step 2: Build and run the existing registry self-check**

```bash
cd backend && npm run build
npm run check:mcp-registry
```

Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add backend/src/mcp-tools.ts
git commit -m "feat(workflows): mcp tool workflow_run_retry (T-250)"
```

---

## Task 18: Engine-integration check script

**Files:** Create `backend/scripts/workflow-engine-check.cjs`, modify `backend/package.json`

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
/*
 * Engine integration check (T-250).
 * Drives the running backend over HTTP through a full workflow run.
 * Requires `docker compose up -d backend`.
 */
const baseUrl = (process.env.DEVGRIMOIRE_BASE_URL || 'http://localhost:3200').replace(/\/$/, '');
const apiKey = process.env.DEVGRIMOIRE_API_KEY;
if (!apiKey) {
  console.error('DEVGRIMOIRE_API_KEY env var required');
  process.exit(2);
}
const projectId = process.env.DEVGRIMOIRE_PROJECT_ID;
if (!projectId) {
  console.error('DEVGRIMOIRE_PROJECT_ID env var required (an existing project to attach the workflow to)');
  process.exit(2);
}

const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${apiKey}`,
};

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
}

async function http(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return json;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  console.log('Creating workflow…');
  const def = await http('POST', '/api/workflows', {
    scope: 'project',
    projectId,
    name: `runner-check-${Date.now()}`,
    trigger: { type: 'manual' },
    nodes: [
      { id: 't', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {}, secretRefs: [] },
      { id: 'log', type: 'action.log', position: { x: 0, y: 0 }, config: { message: 'hello {{nodes.t.scheduleSlotAt}}' }, secretRefs: [] },
      { id: 'todo', type: 'action.todo-create', position: { x: 0, y: 0 }, config: { title: 'Workflow check todo' }, secretRefs: [] },
      { id: 'notify', type: 'action.notify', position: { x: 0, y: 0 }, config: { title: 'Workflow done', body: 'run completed' }, secretRefs: [] },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'log' },
      { id: 'e2', source: 'log', target: 'todo' },
      { id: 'e3', source: 'todo', target: 'notify' },
    ],
  });

  await http('PATCH', `/api/workflows/${def._id}`, { status: 'active' });

  console.log(`Starting run…`);
  const run = await http('POST', '/api/workflows/runs', { definitionId: def._id });
  const runId = run._id;

  console.log(`Polling run ${runId}…`);
  const start = Date.now();
  let final;
  while (Date.now() - start < 15_000) {
    await sleep(300);
    final = await http('GET', `/api/workflows/runs/${runId}`);
    if (['succeeded', 'failed', 'cancelled'].includes(final.status)) break;
  }
  assert(final && final.status === 'succeeded', `run did not succeed (status=${final?.status}, error=${JSON.stringify(final?.error)})`);
  console.log(`✓ run succeeded`);

  const nodeRuns = await http('GET', `/api/workflows/runs/${runId}/node-runs`);
  assert(nodeRuns.length === 4, `expected 4 node-runs, got ${nodeRuns.length}`);
  for (const nr of nodeRuns) {
    assert(nr.status === 'succeeded', `node-run ${nr.nodeId} status=${nr.status}`);
  }
  console.log('✓ all node-runs succeeded');

  const todoNr = nodeRuns.find((n) => n.nodeId === 'todo');
  const todoId = todoNr.outputSnapshot?.todoId;
  assert(todoId, 'todo-create did not produce a todoId');
  const todo = await http('GET', `/api/todos/${todoId}`);
  assert(todo._id === todoId, 'todo fetched by id mismatched');
  console.log(`✓ todo ${todoId} exists`);

  const notifyNr = nodeRuns.find((n) => n.nodeId === 'notify');
  assert(notifyNr.outputSnapshot?.notificationId, 'notify did not produce a notificationId');
  console.log('✓ notify produced notificationId');

  const logNr = nodeRuns.find((n) => n.nodeId === 'log');
  assert(Array.isArray(logNr.logs) && logNr.logs.length > 0, 'log node-run has no logs');
  console.log('✓ log node-run has log entries');

  console.log('Cleanup…');
  await http('DELETE', `/api/todos/${todoId}`).catch(() => {});
  await http('DELETE', `/api/workflows/${def._id}`).catch(() => {});

  console.log('\nAll integration checks passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Register npm script**

In `backend/package.json` add to `scripts`:

```json
"check:workflow-engine": "node scripts/workflow-engine-check.cjs"
```

- [ ] **Step 3: Rebuild and bring the backend up**

```bash
docker compose up -d --build backend
```

Wait for healthy (check `docker ps`).

- [ ] **Step 4: Run the check**

Pick an existing project id via MCP `project_list` or `mongo`-shell, set `DEVGRIMOIRE_API_KEY` and `DEVGRIMOIRE_PROJECT_ID`, then:

```bash
cd backend && npm run check:workflow-engine
```

Expected: all checks pass.

If any check fails, inspect logs (`docker logs devgrimoire-backend --tail 200`) and iterate on the engine code. Don't ship a green-only-because-you-deleted-an-assert script.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/workflow-engine-check.cjs backend/package.json
git commit -m "test(workflows): integration check script for runner (T-250)"
```

---

## Task 19: Lint, manual scheduler smoke, todo update

**Files:** (none — operational)

- [ ] **Step 1: Lint backend**

```bash
cd backend && npm run lint
```

Expected: no errors. Fix any complaints raised by the engine code.

- [ ] **Step 2: Manual scheduler smoke (optional but recommended)**

Create a workflow via MCP `workflow_create` (or REST) with:

```json
{
  "scope": "project",
  "projectId": "<existing>",
  "name": "scheduler-smoke",
  "trigger": { "type": "schedule", "intervalMinutes": 1 },
  "nodes": [
    { "id": "t", "type": "trigger.schedule", "position": {"x":0,"y":0}, "config": {}, "secretRefs": [] },
    { "id": "log", "type": "action.log", "position": {"x":0,"y":0}, "config": {"message": "tick"}, "secretRefs": [] }
  ],
  "edges": [{ "id": "e1", "source": "t", "target": "log" }]
}
```

Set status to `active`. Wait 2.5 minutes. Call `workflow_run_list` (filtered by `definitionId`). Expected: ≥2 runs with `status=succeeded`.

Pause: `PATCH /api/workflows/:id` with `{ "status": "paused" }`. Wait 2 min. Verify no further runs created.

- [ ] **Step 3: Post review comment to T-250**

Via DevGrimoire MCP `todo_comment` on T-250 — summary of what was implemented, list of new files, the check scripts that pass, any known follow-ups (e.g., cycle detection still relies on `validateGraph` static-only, deferred to T-252).

- [ ] **Step 4: Move T-250 to `review`**

Via `todo_update` set `status: review`. Per CLAUDE.md, run an honest code-review pass (re-read engine, look for races, missing nullguards, edge cases — Worker-Pool with concurrency=1 hides multi-worker races; lock contention paths; recovery loop) and append findings as comments. Fix any real issues, re-run the check scripts, then transition to `done`.

---

## Self-Review Summary

**Spec coverage** — each requirement mapped to a task:

| Spec requirement | Task(s) |
|---|---|
| Engine architecture | 10–12 |
| In-memory queue + DB recovery | 10, 12 (recovery in step 11) |
| Worker pool + definition-locks | 10, 11, 12 |
| Scheduler with cron + intervalMinutes + catch-up | 6, 13 |
| Resume via question entity | 12 (step 9) |
| Retry (auto + manual) | 12 (step 7), 12 (step 9), 15, 17 |
| Crash recovery on bootstrap | 12 (step 11) |
| Schema extensions | 2 |
| DTO + service `triggeredBy` + queued event | 14 |
| Mini-node catalog (manual/schedule/log/todo-create/notify) | 9 |
| Template expansion | 7, 9 |
| Pure-logic check script | 8 |
| HTTP integration check | 18 |
| Lint + manual scheduler smoke | 19 |
| MCP retry tool | 17 |

**Type consistency** — `NodeResult.status` uses `'success' | 'failed' | 'waiting'` consistently across Task 3 (type), Task 9 (executors), Task 12 (apply-result). `WorkflowNodeRunStatus.INTERRUPTED` added in Task 2 and referenced in Task 12 recovery. `triggeredBy.scheduleSlotAt` is `Date` in schema (Task 2) and `Date` in service (Task 14, step 2) — DTO accepts ISO string and converts.

**Open follow-ups** (correctly out of scope, captured in spec): cycle detection beyond self-loops, multi-instance queue coordination, full node catalog (T-252), canvas (T-251).
