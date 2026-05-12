import { request } from './client';

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
  parentRunId?: string;
  retryFromNodeId?: string;
  executedNodeCount?: number;
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

export const workflowsApi = {
  listNodeTypes: () => request<WorkflowNodeMetadata[]>('/workflows/node-types'),
  list: (filter: ListFilter = {}) =>
    request<WorkflowDefinition[]>(`/workflows${toQuery(filter as Record<string, unknown>)}`),
  get: (id: string) => request<WorkflowDefinition>(`/workflows/${id}`),
  create: (dto: CreateWorkflowDto) =>
    request<WorkflowDefinition>('/workflows', { method: 'POST', body: JSON.stringify(dto) }),
  update: (id: string, dto: UpdateWorkflowDto) =>
    request<WorkflowDefinition>(`/workflows/${id}`, { method: 'PUT', body: JSON.stringify(dto) }),
  delete: (id: string) => request<void>(`/workflows/${id}`, { method: 'DELETE' }),

  start: (definitionId: string, input?: Record<string, unknown>) =>
    request<WorkflowRun>('/workflows/runs', {
      method: 'POST',
      body: JSON.stringify({ definitionId, input }),
    }),
  listRuns: (filter: RunFilter = {}) =>
    request<WorkflowRun[]>(`/workflows/runs/list${toQuery(filter as Record<string, unknown>)}`),
  getRun: (id: string) => request<WorkflowRun>(`/workflows/runs/${id}`),
  cancelRun: (id: string, reason?: string) =>
    request<WorkflowRun>(`/workflows/runs/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  retryRun: (id: string, fromNodeId?: string) =>
    request<{ ok: true; runId: string; parentRunId: string }>(`/workflows/runs/${id}/retry`, {
      method: 'POST',
      body: JSON.stringify({ fromNodeId }),
    }),
  listTemplates: () =>
    request<Array<{
      id: string;
      name: string;
      description: string;
      category: string;
      supportedScopes: WorkflowScope[];
      triggerType: 'manual' | 'schedule';
      nodeCount: number;
    }>>('/workflows/templates'),
  instantiateTemplate: (input: { templateId: string; name: string; scope: WorkflowScope; projectId?: string; customerId?: string }) =>
    request<WorkflowDefinition>('/workflows/templates/instantiate', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listNodeRuns: (runId: string) =>
    request<WorkflowNodeRun[]>(`/workflows/runs/${runId}/node-runs`),
};
