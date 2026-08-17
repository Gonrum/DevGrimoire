import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, mongo } from 'mongoose';
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
  /**
   * ISO timestamp of the soft timeout. `null` when the question has no wait
   * window — QuestionsService emits `expiresAt: null` explicitly, so the field
   * is nullable, not just optional.
   */
  expiresAt?: string | null;
  answer?: string;
  answeredByUserId?: string | null;
}

/**
 * Payload of the `question.created` signal emitted by QuestionsService on the
 * local EventEmitter. Only `questionId` is guaranteed; everything else stays
 * optional so a payload that grows or shrinks on the emitter side can never
 * make the bus drop an event.
 */
export interface QuestionCreatedPayload {
  questionId: string;
  question?: string;
  options?: string[];
  context?: string;
  todoId?: string | null;
  projectId?: string | null;
  targetUserId?: string | null;
  expiresAt?: string | null;
}

/** Payload of the `question.answered` signal emitted by QuestionsService. */
export interface QuestionAnsweredPayload {
  questionId: string;
  answer?: string;
  answeredByUserId?: string | null;
}

/**
 * A change-stream document as it comes off the raw driver: plain BSON, no
 * Mongoose hydration. Every field is `unknown` and optional on purpose — the
 * watcher spans ~19 collections with different shapes, and a field that only
 * exists for some of them must not narrow the type of the others.
 */
interface ChangeDoc {
  _id?: unknown;
  [field: string]: unknown;
}

/**
 * The change-stream operations we translate into bus events — single source of
 * truth for both the action map and the narrowing guard below. All four are
 * document-level operations, i.e. they always carry `ns` and `documentKey`
 * (unlike drop/rename/invalidate, which the watcher ignores).
 */
const DOCUMENT_OPERATIONS = ['insert', 'update', 'replace', 'delete'] as const;
type DocumentOperation = (typeof DOCUMENT_OPERATIONS)[number];

type AnyChange = mongo.ChangeStreamDocument<ChangeDoc>;
type DocumentChange = Extract<AnyChange, { operationType: DocumentOperation }>;

/** BSON ids/strings → string. Anything else yields undefined instead of "[object Object]". */
function toIdString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value instanceof mongo.ObjectId) return value.toHexString();
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/** BSON dates arrive as `Date`; tolerate an already-stringified value too. */
function toIsoString(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return asString(value);
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

const OPERATION_ACTION_MAP: Record<DocumentOperation, ProjectChangeEvent['action']> = {
  insert: 'created',
  update: 'updated',
  replace: 'updated',
  delete: 'deleted',
};

/**
 * Guard + narrowing in one. Everything that is not a document-level operation
 * (drop, rename, invalidate, index events, …) is ignored — exactly as before,
 * when the missing OPERATION_ACTION_MAP entry triggered the early return.
 */
function isDocumentChange(change: AnyChange): change is DocumentChange {
  return DOCUMENT_OPERATIONS.some((operation) => operation === change.operationType);
}

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
  private changeStream: mongo.ChangeStream<ChangeDoc, AnyChange> | null = null;
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
    // Fire-and-forget as before; a failing close during shutdown is nothing we
    // can act on, but it must not surface as an unhandled rejection.
    this.changeStream?.close().catch(() => {
      /* shutting down anyway */
    });
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
      this.changeStream = db.watch<ChangeDoc>(pipeline, { fullDocument: 'updateLookup' });

      this.changeStream.on('change', (change) => {
        if (!isDocumentChange(change)) return;
        const action = OPERATION_ACTION_MAP[change.operationType];
        const coll = change.ns.coll;
        // `fullDocument` is absent on deletes and can be missing on updates
        // (document already gone when updateLookup ran) — fall back to the
        // documentKey, which carries at least the _id (plus shard keys).
        const fullDocument = 'fullDocument' in change ? change.fullDocument : undefined;
        const doc: ChangeDoc = fullDocument ?? change.documentKey;
        const docId = toIdString(doc._id) ?? toIdString(change.documentKey._id);

        if (coll === QUESTION_COLLECTION && change.operationType === 'insert') {
          if (docId && asString(doc.status) === 'pending') {
            this.questionEvents$$.next({
              type: 'question_created',
              questionId: docId,
              question: asString(doc.question),
              options: asStringArray(doc.options) ?? [],
              context: asString(doc.context),
              todoId: toIdString(doc.todoId) ?? null,
              projectId: toIdString(doc.projectId) ?? null,
              targetUserId: toIdString(doc.targetUserId) ?? null,
              expiresAt: toIsoString(doc.expiresAt),
            });
          }
          return;
        }
        if (
          coll === QUESTION_COLLECTION &&
          (change.operationType === 'update' || change.operationType === 'replace')
        ) {
          if (docId && asString(doc.status) === 'answered') {
            this.questionEvents$$.next({
              type: 'question_answered',
              questionId: docId,
              answer: asString(doc.answer),
              answeredByUserId: toIdString(doc.answeredByUserId) ?? null,
            });
          }
          return;
        }

        const entity = COLLECTION_ENTITY_MAP[coll];
        if (!entity) return;

        let projectId: string | null | undefined;
        let customerId: string | null | undefined;
        if (entity === 'project') {
          projectId = docId;
        } else {
          projectId = toIdString(doc.projectId);
          customerId = toIdString(doc.customerId);
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
          entityId: docId,
        };

        if (this.isDuplicate(event)) return;
        this.events$$.next(event);
      });

      this.changeStream.on('error', (err) => {
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
  handleQuestionCreated(event: QuestionCreatedPayload) {
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
  handleQuestionAnswered(event: QuestionAnsweredPayload) {
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
