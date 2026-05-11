import { WorkflowScope } from './schemas/workflow-definition.schema';

export type WorkflowNodeRisk =
  | 'safe-read'
  | 'safe-write'
  | 'human-wait'
  | 'agent-write'
  | 'secret-read'
  | 'external-call'
  | 'workspace-git'
  | 'destructive';

export interface WorkflowNodePolicy {
  type: string;
  risk: WorkflowNodeRisk;
  allowedScopes: WorkflowScope[];
  mvpAllowed: boolean;
}

const ALL_SCOPES = [WorkflowScope.SYSTEM, WorkflowScope.PROJECT, WorkflowScope.CUSTOMER];
const PROJECT_CUSTOMER = [WorkflowScope.PROJECT, WorkflowScope.CUSTOMER];

export const WORKFLOW_NODE_POLICIES: Record<string, WorkflowNodePolicy> = {
  'trigger.manual': { type: 'trigger.manual', risk: 'safe-read', allowedScopes: ALL_SCOPES, mvpAllowed: true },
  'trigger.schedule': { type: 'trigger.schedule', risk: 'safe-read', allowedScopes: ALL_SCOPES, mvpAllowed: true },
  'trigger.project_event': { type: 'trigger.project_event', risk: 'safe-read', allowedScopes: [WorkflowScope.PROJECT], mvpAllowed: true },
  'trigger.customer_event': { type: 'trigger.customer_event', risk: 'safe-read', allowedScopes: [WorkflowScope.CUSTOMER], mvpAllowed: true },
  'todo.create': { type: 'todo.create', risk: 'safe-write', allowedScopes: PROJECT_CUSTOMER, mvpAllowed: true },
  'todo.update': { type: 'todo.update', risk: 'safe-write', allowedScopes: PROJECT_CUSTOMER, mvpAllowed: true },
  'todo.comment': { type: 'todo.comment', risk: 'safe-write', allowedScopes: PROJECT_CUSTOMER, mvpAllowed: true },
  'todo.link_milestone': { type: 'todo.link_milestone', risk: 'safe-write', allowedScopes: [WorkflowScope.PROJECT], mvpAllowed: true },
  'knowledge.create': { type: 'knowledge.create', risk: 'safe-write', allowedScopes: PROJECT_CUSTOMER, mvpAllowed: true },
  'manual.create': { type: 'manual.create', risk: 'safe-write', allowedScopes: PROJECT_CUSTOMER, mvpAllowed: true },
  'changelog.add': { type: 'changelog.add', risk: 'safe-write', allowedScopes: [WorkflowScope.PROJECT], mvpAllowed: true },
  'user.question': { type: 'user.question', risk: 'human-wait', allowedScopes: ALL_SCOPES, mvpAllowed: true },
  'condition.switch': { type: 'condition.switch', risk: 'safe-read', allowedScopes: ALL_SCOPES, mvpAllowed: true },
  'delay.wait': { type: 'delay.wait', risk: 'safe-read', allowedScopes: ALL_SCOPES, mvpAllowed: true },
  'notification.send': { type: 'notification.send', risk: 'safe-write', allowedScopes: ALL_SCOPES, mvpAllowed: true },
  'log.write': { type: 'log.write', risk: 'safe-write', allowedScopes: ALL_SCOPES, mvpAllowed: true },
  'rag.search': { type: 'rag.search', risk: 'safe-read', allowedScopes: PROJECT_CUSTOMER, mvpAllowed: true },
  'agent.task': { type: 'agent.task', risk: 'agent-write', allowedScopes: PROJECT_CUSTOMER, mvpAllowed: false },
  'secret.read': { type: 'secret.read', risk: 'secret-read', allowedScopes: PROJECT_CUSTOMER, mvpAllowed: false },
  'http.request': { type: 'http.request', risk: 'external-call', allowedScopes: ALL_SCOPES, mvpAllowed: false },
  'workspace.exec': { type: 'workspace.exec', risk: 'workspace-git', allowedScopes: [WorkflowScope.PROJECT], mvpAllowed: false },
  'git.action': { type: 'git.action', risk: 'workspace-git', allowedScopes: [WorkflowScope.PROJECT], mvpAllowed: false },
  'entity.delete': { type: 'entity.delete', risk: 'destructive', allowedScopes: ALL_SCOPES, mvpAllowed: false },
  // action.* aliases — executor-side naming used by the node implementations
  'action.log': { type: 'action.log', risk: 'safe-write', allowedScopes: ALL_SCOPES, mvpAllowed: true },
  'action.todo-create': { type: 'action.todo-create', risk: 'safe-write', allowedScopes: PROJECT_CUSTOMER, mvpAllowed: true },
  'action.notify': { type: 'action.notify', risk: 'safe-write', allowedScopes: ALL_SCOPES, mvpAllowed: true },
};

const LEGACY_TYPE_ALIASES: Record<string, string> = {
  manual: 'trigger.manual',
  schedule: 'trigger.schedule',
  project_event: 'trigger.project_event',
  customer_event: 'trigger.customer_event',
  todo_create: 'todo.create',
  todo_update: 'todo.update',
  todo_comment: 'todo.comment',
  user_question: 'user.question',
  switch: 'condition.switch',
  condition: 'condition.switch',
  delay: 'delay.wait',
  notification: 'notification.send',
  log: 'log.write',
  agent_task: 'agent.task',
};

export function normalizeWorkflowNodeType(type: string | undefined): string | undefined {
  if (!type) return undefined;
  return LEGACY_TYPE_ALIASES[type] ?? type;
}

export function getWorkflowNodePolicy(type: string | undefined): WorkflowNodePolicy | undefined {
  const normalized = normalizeWorkflowNodeType(type);
  return normalized ? WORKFLOW_NODE_POLICIES[normalized] : undefined;
}

export function workflowSecurityIssues(def: {
  scope?: WorkflowScope;
  nodes?: Array<{ id: string; type?: string; secretRefs?: string[] }>;
}): string[] {
  const issues: string[] = [];
  for (const node of def.nodes ?? []) {
    const label = node.id || '(without id)';
    const policy = getWorkflowNodePolicy(node.type);
    if (!policy) {
      issues.push(`node "${label}" has unknown or unsupported type "${node.type ?? ''}"`);
      continue;
    }
    if (def.scope && !policy.allowedScopes.includes(def.scope)) {
      issues.push(`node "${label}" type "${policy.type}" is not allowed for ${def.scope} workflows`);
    }
    if (!policy.mvpAllowed) {
      issues.push(`node "${label}" type "${policy.type}" has risk "${policy.risk}" and is blocked in MVP`);
    }
    if ((node.secretRefs?.length ?? 0) > 0 && policy.risk !== 'secret-read') {
      issues.push(`node "${label}" declares secretRefs but type "${policy.type}" is not a secret-aware node`);
    }
  }
  return issues;
}
