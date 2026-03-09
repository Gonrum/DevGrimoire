export const PROJECT_CHANGED = 'project.changed';

export interface ProjectChangeEvent {
  projectId: string;
  entity: 'project' | 'todo' | 'session' | 'knowledge' | 'changelog' | 'milestone' | 'manual' | 'research' | 'notification';
  action: 'created' | 'updated' | 'deleted';
  entityId?: string;
  summary?: string;
}
