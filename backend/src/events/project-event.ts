export const PROJECT_CHANGED = 'project.changed';

export interface ProjectChangeEvent {
  projectId: string | null;
  /** Customer owner when the changed entity is customer-scoped (no project). Both can be null for global entities. */
  customerId?: string | null;
  entity: 'project' | 'todo' | 'session' | 'knowledge' | 'changelog' | 'milestone' | 'manual' | 'research' | 'notification' | 'environment' | 'secret' | 'schema' | 'dependency' | 'feature' | 'soul' | 'commit' | 'recurring-task' | 'snippet' | 'attachment' | 'log' | 'release' | 'chat' | 'workspace' | 'customer-project' | 'contact' | 'customer' | 'healthcheck' | 'doc-update-proposal';
  action: 'created' | 'updated' | 'deleted';
  entityId?: string;
  summary?: string;
  /** When set, the event is private to this user — SSE filters route it to that user only */
  userId?: string;
}
