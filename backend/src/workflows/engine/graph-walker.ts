import { WorkflowEdge, WorkflowNode } from '../schemas/workflow-definition.schema';

interface GraphSnapshot {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

const LEGACY_TRIGGER_TYPES = new Set(['manual', 'schedule', 'project_event', 'customer_event']);

function isTriggerType(type: string): boolean {
  return type.startsWith('trigger.') || LEGACY_TRIGGER_TYPES.has(type);
}

/** All trigger nodes (type starts with "trigger." or is a legacy bare trigger name) in deterministic id order. */
export function findTriggerNodes(def: GraphSnapshot): WorkflowNode[] {
  return def.nodes
    .filter((n) => isTriggerType(n.type))
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
