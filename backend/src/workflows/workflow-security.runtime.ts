import { WorkflowScope } from './schemas/workflow-definition.schema';
import {
  getWorkflowNodePolicy,
  WORKFLOW_NODE_POLICIES,
  WorkflowNodePolicy,
} from './workflow-security.policy';

/**
 * Runtime budgets from docs/workflow-security.md. Defaults are conservative —
 * override via env if you really need higher caps and the change is reviewed.
 */
export const WORKFLOW_RUNTIME_LIMITS = {
  /** Hard cap on node executions per run (loop/cost protection). */
  maxNodesPerRun: Number(process.env.WORKFLOW_MAX_NODES_PER_RUN ?? 100),
  /** Total run wall-clock budget. Trips: run is marked failed. */
  maxRunDurationMs: Number(process.env.WORKFLOW_MAX_RUN_DURATION_MS ?? 30 * 60_000),
  /** Per-node executor timeout default. Overridable via node.config.timeoutMs. */
  defaultNodeTimeoutMs: Number(process.env.WORKFLOW_DEFAULT_NODE_TIMEOUT_MS ?? 2 * 60_000),
  /** Persistence cap per log line after redaction (4 KB per docs). */
  maxLogLineChars: Number(process.env.WORKFLOW_MAX_LOG_LINE_CHARS ?? 4096),
  /** Max number of nodes a definition is allowed to have. */
  maxNodesPerDefinition: Number(process.env.WORKFLOW_MAX_NODES_PER_DEFINITION ?? 100),
} as const;

export interface RuntimeNodeCheckInput {
  scope: WorkflowScope;
  type: string;
  secretRefs?: string[];
}

export interface RuntimeNodeCheckResult {
  ok: boolean;
  /** Stable machine-readable reason — used as audit/event `code`. */
  code?:
    | 'unknown_type'
    | 'mvp_blocked'
    | 'scope_mismatch'
    | 'secret_refs_misplaced';
  message?: string;
  policy?: WorkflowNodePolicy;
}

/**
 * Re-check a single node against the policy registry at execution time.
 *
 * Defense in depth — the activation gate already enforces this, but a snapshot
 * may have been activated under an older policy. Failing closed here ensures
 * blocked node families can never reach an executor even if they somehow
 * slipped through.
 */
export function checkRuntimeNode(input: RuntimeNodeCheckInput): RuntimeNodeCheckResult {
  const policy = getWorkflowNodePolicy(input.type);
  if (!policy) {
    return {
      ok: false,
      code: 'unknown_type',
      message: `node type "${input.type}" is not registered in the workflow policy`,
    };
  }
  if (!policy.mvpAllowed) {
    return {
      ok: false,
      code: 'mvp_blocked',
      message: `node type "${policy.type}" has risk "${policy.risk}" and is blocked in MVP`,
      policy,
    };
  }
  if (!policy.allowedScopes.includes(input.scope)) {
    return {
      ok: false,
      code: 'scope_mismatch',
      message: `node type "${policy.type}" not allowed in ${input.scope} scope`,
      policy,
    };
  }
  if ((input.secretRefs?.length ?? 0) > 0 && policy.risk !== 'secret-read') {
    return {
      ok: false,
      code: 'secret_refs_misplaced',
      message: `node type "${policy.type}" must not declare secretRefs`,
      policy,
    };
  }
  return { ok: true, policy };
}

export interface RunBudgetCheckResult {
  ok: boolean;
  code?: 'node_count_exceeded' | 'duration_exceeded';
  message?: string;
}

/**
 * Verify the run is still within its budget. Called before each node enqueue
 * AND before each node execution (defense in depth — a job might sit in queue
 * for longer than expected).
 */
export function checkRunBudget(input: {
  startedAt?: Date;
  executedNodeCount?: number;
}): RunBudgetCheckResult {
  const count = input.executedNodeCount ?? 0;
  if (count >= WORKFLOW_RUNTIME_LIMITS.maxNodesPerRun) {
    return {
      ok: false,
      code: 'node_count_exceeded',
      message: `run exceeded ${WORKFLOW_RUNTIME_LIMITS.maxNodesPerRun} node executions`,
    };
  }
  if (input.startedAt) {
    const age = Date.now() - input.startedAt.getTime();
    if (age >= WORKFLOW_RUNTIME_LIMITS.maxRunDurationMs) {
      return {
        ok: false,
        code: 'duration_exceeded',
        message: `run exceeded ${WORKFLOW_RUNTIME_LIMITS.maxRunDurationMs}ms wall clock`,
      };
    }
  }
  return { ok: true };
}

/** Risk summary used by the activation approval record. */
export function summarizeRisk(
  nodes: Array<{ type?: string }>,
): { byRisk: Record<string, number>; allowedNodeTypes: string[]; nodeCount: number } {
  const byRisk: Record<string, number> = {};
  const allowedNodeTypes = new Set<string>();
  for (const node of nodes) {
    const policy = getWorkflowNodePolicy(node.type);
    if (!policy) continue;
    byRisk[policy.risk] = (byRisk[policy.risk] ?? 0) + 1;
    allowedNodeTypes.add(policy.type);
  }
  return {
    byRisk,
    allowedNodeTypes: Array.from(allowedNodeTypes).sort(),
    nodeCount: nodes.length,
  };
}

/** All node types currently allowed in MVP — exposed for UI/docs. */
export function listMvpAllowedNodeTypes(): string[] {
  return Object.values(WORKFLOW_NODE_POLICIES)
    .filter((p) => p.mvpAllowed)
    .map((p) => p.type)
    .sort();
}
