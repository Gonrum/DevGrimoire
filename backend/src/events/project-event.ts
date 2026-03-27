export const PROJECT_CHANGED = 'project.changed';

export interface ProjectChangeEvent {
  projectId: string | null;
  entity: 'project' | 'todo' | 'session' | 'knowledge' | 'changelog' | 'milestone' | 'manual' | 'research' | 'notification' | 'environment' | 'secret' | 'schema' | 'dependency' | 'feature' | 'soul' | 'commit' | 'recurring-task' | 'snippet' | 'attachment';
  action: 'created' | 'updated' | 'deleted';
  entityId?: string;
  summary?: string;
}
