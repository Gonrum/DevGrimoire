export const PROJECT_CHANGED = 'project.changed';
export const REPLICATION_STATUS_CHANGED = 'replication.statusChanged';
export const WORKFLOW_RUN_PROGRESS = 'workflow.run.progress';

/**
 * Alle Entity-Werte, die als `project.changed` über den Bus gehen (M-32).
 *
 * Eine Liste statt einer handgepflegten Union: `check:event-entities`
 * vergleicht sie mit jedem `entity: '…'` an einem `emit(PROJECT_CHANGED, …)`
 * im Backend und mit der Union in `frontend/src/api/wsEventBus.ts`. Vorher
 * deklarierte das Frontend 27 Werte, das Backend emittierte mehr, und die
 * Refetch-Tabelle hatte einen Eintrag (`log`) für ein Event, das nie kam.
 */
export const PROJECT_EVENT_ENTITIES = [
  'project', 'todo', 'session', 'knowledge', 'changelog', 'milestone', 'manual',
  'research', 'research_artifact', 'notification', 'environment', 'secret', 'schema',
  'dependency', 'feature', 'soul', 'harness', 'commit', 'recurring-task', 'snippet',
  'attachment', 'release', 'chat', 'workspace', 'customer-project', 'contact', 'customer',
  'customer-template-apply', 'healthcheck', 'doc-update-proposal', 'knowledge-graph',
  'oracle', 'ssh-connection', 'ssh-audit', 'question', 'replication-status',
  'workflow-definition', 'workflow-run', 'validation-report',
] as const;

export type ProjectEventEntity = typeof PROJECT_EVENT_ENTITIES[number];

export interface ProjectChangeEvent {
  projectId: string | null;
  /** Customer owner when the changed entity is customer-scoped (no project). Both can be null for global entities. */
  customerId?: string | null;
  entity: ProjectEventEntity;
  action: 'created' | 'updated' | 'deleted';
  entityId?: string;
  summary?: string;
  /** When set, the event is private to this user — SSE filters route it to that user only */
  userId?: string;
}
