import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { Observable, Subject } from 'rxjs';
import { PROJECT_CHANGED, REPLICATION_STATUS_CHANGED, WORKFLOW_RUN_PROGRESS, ProjectChangeEvent } from './project-event';
import { NOTIFICATION_CREATED } from '../notifications/notifications.service';
import { QUESTION_CREATED, QUESTION_ANSWERED } from '../questions/questions.service';

export interface QuestionEvent {
  type: 'question_created' | 'question_answered';
  questionId: string;
  question?: string;
  options?: string[];
  context?: string;
  todoId?: string | null;
  projectId?: string | null;
  targetUserId?: string | null;
  expiresAt?: string;
  answer?: string;
  answeredByUserId?: string | null;
}

const COLLECTION_ENTITY_MAP: Record<string, ProjectChangeEvent['entity']> = {
  todos: 'todo',
  projects: 'project',
  sessions: 'session',
  knowledges: 'knowledge',
  changelogs: 'changelog',
  milestones: 'milestone',
  manuals: 'manual',
  researches: 'research',
  environments: 'environment',
  secrets: 'secret',
  schemas: 'schema',
  dependencies: 'dependency',
  features: 'feature',
  souls: 'soul',
  commits: 'commit',
  workspaces: 'workspace',
  sshconnections: 'ssh-connection',
  sshaudits: 'ssh-audit',
};

// Entities whose owner can be either project- OR customer-scoped. The
// change-stream watcher emits both ids so subscribers (and the WS multiplex
// filter) can route customer-scoped events correctly even when projectId is
// null on the document.
const DUAL_SCOPED_ENTITIES = new Set<ProjectChangeEvent['entity']>([
  'ssh-connection',
  'secret',
  'environment',
  'healthcheck',
  'contact',
]);

const QUESTION_COLLECTION = 'questions';

const OPERATION_ACTION_MAP: Record<string, ProjectChangeEvent['action']> = {
  insert: 'created',
  update: 'updated',
  replace: 'updated',
  delete: 'deleted',
};

/**
 * Central in-process event bus for live updates. Sourced from two places:
 *   1) MongoDB Change Streams (cross-process — replica set only)
 *   2) @OnEvent handlers on the local EventEmitter2 (same process)
 *
 * Exposed as RxJS Observables so multiple transports (SSE controller,
 * WebSocket upgrade handler) can subscribe with their own per-connection
 * filter logic.
 */
@Injectable()
export class EventsBusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsBusService.name);
  private readonly events$$ = new Subject<ProjectChangeEvent>();
  private readonly questionEvents$$ = new Subject<QuestionEvent>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private changeStream: any = null;
  private readonly recentEvents = new Map<string, number>();
  private readonly standalone: boolean;

  constructor(@InjectConnection() private readonly connection: Connection) {
    this.standalone = process.env.MONGODB_STANDALONE === 'true';
  }

  get events$(): Observable<ProjectChangeEvent> {
    return this.events$$.asObservable();
  }

  get questionEvents$(): Observable<QuestionEvent> {
    return this.questionEvents$$.asObservable();
  }

  onModuleInit() {
    if (this.standalone) {
      this.logger.log('Standalone mode: Change Streams disabled, using EventEmitter only');
      return;
    }
    this.watchChangeStreams();
  }

  onModuleDestroy() {
    this.changeStream?.close();
  }

  private watchChangeStreams() {
    const watchedCollections = [...Object.keys(COLLECTION_ENTITY_MAP), QUESTION_COLLECTION];
    const pipeline = [{ $match: { 'ns.coll': { $in: watchedCollections } } }];

    try {
      const db = this.connection.db;
      if (!db) {
        this.logger.warn('Database not available for Change Streams');
        return;
      }
      this.changeStream = db.watch(pipeline, { fullDocument: 'updateLookup' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.changeStream.on('change', (change: any) => {
        const coll = change.ns?.coll;
        const doc = change.fullDocument || change.documentKey;
        const action = OPERATION_ACTION_MAP[change.operationType];
        if (!action) return;

        if (coll === QUESTION_COLLECTION && doc && change.operationType === 'insert') {
          const questionId = doc._id?.toString();
          if (questionId && doc.status === 'pending') {
            this.questionEvents$$.next({
              type: 'question_created',
              questionId,
              question: doc.question,
              options: doc.options || [],
              context: doc.context,
              todoId: doc.todoId?.toString() || null,
              projectId: doc.projectId?.toString() || null,
              targetUserId: doc.targetUserId?.toString() || null,
              expiresAt: doc.expiresAt?.toISOString?.() || doc.expiresAt,
            });
          }
          return;
        }
        if (
          coll === QUESTION_COLLECTION &&
          doc &&
          (change.operationType === 'update' || change.operationType === 'replace')
        ) {
          const questionId = (doc._id || change.documentKey?._id)?.toString();
          if (questionId && doc.status === 'answered') {
            this.questionEvents$$.next({
              type: 'question_answered',
              questionId,
              answer: doc.answer,
              answeredByUserId: doc.answeredByUserId?.toString() || null,
            });
          }
          return;
        }

        const entity = COLLECTION_ENTITY_MAP[coll];
        if (!entity) return;

        let projectId: string | null | undefined;
        let customerId: string | null | undefined;
        if (entity === 'project') {
          projectId = (doc?._id || change.documentKey?._id)?.toString();
        } else {
          projectId = doc?.projectId?.toString();
          customerId = doc?.customerId?.toString();
        }
        // ssh-audit rows carry only `connectionId` — no project/customer. We
        // still want to broadcast them so the audit-tab can live-refresh; the
        // WS filter's "projectId === null" branch handles this.
        if (entity === 'ssh-audit') {
          projectId = null;
          customerId = null;
        }
        // Dual-scoped entities can be customer-scoped (no projectId). Allow
        // null projectId in that case so the WS bus can still broadcast (or
        // future-route by customerId).
        if (!projectId && !DUAL_SCOPED_ENTITIES.has(entity)) return;

        const event: ProjectChangeEvent = {
          projectId: projectId ?? null,
          customerId: customerId ?? null,
          entity,
          action,
          entityId: (doc?._id || change.documentKey?._id)?.toString(),
        };

        if (this.isDuplicate(event)) return;
        this.events$$.next(event);
      });

      this.changeStream.on('error', (err: Error) => {
        this.logger.error('Change stream error', err.message);
      });

      this.logger.log('MongoDB Change Stream watching: ' + watchedCollections.join(', '));
    } catch {
      this.logger.warn(
        'Change Streams not available (requires replica set). Falling back to EventEmitter only.',
      );
    }
  }

  private isDuplicate(event: ProjectChangeEvent): boolean {
    const key = `${event.projectId ?? ''}:${event.customerId ?? ''}:${event.entity}:${event.action}:${event.entityId}`;
    const now = Date.now();
    const lastSeen = this.recentEvents.get(key);
    if (lastSeen && now - lastSeen < 300) return true;
    this.recentEvents.set(key, now);
    if (this.recentEvents.size > 100) {
      for (const [k, t] of this.recentEvents) {
        if (now - t > 5000) this.recentEvents.delete(k);
      }
    }
    return false;
  }

  @OnEvent(PROJECT_CHANGED)
  handleProjectChange(event: ProjectChangeEvent) {
    if (this.isDuplicate(event)) return;
    this.events$$.next(event);
  }

  @OnEvent(NOTIFICATION_CREATED)
  handleNotificationCreated(event: { id: string; title: string; body: string }) {
    this.events$$.next({
      projectId: '__global__',
      entity: 'notification',
      action: 'created',
      entityId: event.id,
      summary: event.title,
    });
  }

  @OnEvent(QUESTION_CREATED)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleQuestionCreated(event: any) {
    this.questionEvents$$.next({
      type: 'question_created',
      questionId: event.questionId,
      question: event.question,
      options: event.options,
      context: event.context,
      todoId: event.todoId,
      projectId: event.projectId,
      targetUserId: event.targetUserId,
      expiresAt: event.expiresAt,
    });
  }

  @OnEvent(QUESTION_ANSWERED)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleQuestionAnswered(event: any) {
    this.questionEvents$$.next({
      type: 'question_answered',
      questionId: event.questionId,
      answer: event.answer,
      answeredByUserId: event.answeredByUserId,
    });
  }

  @OnEvent(REPLICATION_STATUS_CHANGED)
  handleReplicationStatusChanged() {
    // Broadcast trigger — frontend re-fetches /api/replication/status on hit.
    // No payload: queueSize, lastSync etc. are pulled fresh so we don't have
    // to keep WS event shape in sync with the status DTO.
    this.events$$.next({
      projectId: null,
      entity: 'replication-status',
      action: 'updated',
    });
  }

  // T-353: route all run-lifecycle signals from the workflow engine into the
  // WS bus as a single `workflow-run` entity. queued/finished are the existing
  // engine signals; progress is the new per-node trigger. Frontend filters by
  // entityId to scope to a single run-inspector window.
  @OnEvent(WORKFLOW_RUN_PROGRESS)
  @OnEvent('workflow.run.queued')
  @OnEvent('workflow.run.finished')
  handleWorkflowRunProgress(payload: { runId?: string }) {
    if (!payload?.runId) return;
    this.events$$.next({
      projectId: null,
      entity: 'workflow-run',
      action: 'updated',
      entityId: payload.runId,
    });
  }
}
