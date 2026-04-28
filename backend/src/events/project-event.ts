export const PROJECT_CHANGED = 'project.changed';

export interface ProjectChangeEvent {
  projectId: string | null;
  entity: 'project' | 'todo' | 'session' | 'knowledge' | 'changelog' | 'milestone' | 'manual' | 'research' | 'notification' | 'environment' | 'secret' | 'schema' | 'dependency' | 'feature' | 'soul' | 'commit' | 'recurring-task' | 'snippet' | 'attachment' | 'log' | 'release' | 'chat' | 'workspace';
  action: 'created' | 'updated' | 'deleted';
  entityId?: string;
  summary?: string;
  /** When set, the event is private to this user — SSE filters route it to that user only */
  userId?: string;
}
