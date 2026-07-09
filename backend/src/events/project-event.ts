export const PROJECT_CHANGED = 'project.changed';
export const REPLICATION_STATUS_CHANGED = 'replication.statusChanged';
export const WORKFLOW_RUN_PROGRESS = 'workflow.run.progress';

export interface ProjectChangeEvent {
  projectId: string | null;
  /** Customer owner when the changed entity is customer-scoped (no project). Both can be null for global entities. */
  customerId?: string | null;
  entity: 'project' | 'todo' | 'session' | 'knowledge' | 'changelog' | 'milestone' | 'manual' | 'research' | 'research_artifact' | 'notification' | 'environment' | 'secret' | 'schema' | 'dependency' | 'feature' | 'soul' | 'commit' | 'recurring-task' | 'snippet' | 'attachment' | 'log' | 'release' | 'chat' | 'workspace' | 'customer-project' | 'contact' | 'customer' | 'healthcheck' | 'doc-update-proposal' | 'knowledge-graph' | 'oracle' | 'ssh-connection' | 'ssh-audit' | 'question' | 'replication-status' | 'workflow-run';
  action: 'created' | 'updated' | 'deleted';
  entityId?: string;
  summary?: string;
  /** When set, the event is private to this user — SSE filters route it to that user only */
  userId?: string;
}
