import { Controller, Logger, OnModuleDestroy, OnModuleInit, Query, Sse } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { Observable, Subject, filter, map } from 'rxjs';
import { PROJECT_CHANGED, ProjectChangeEvent } from './project-event';
import { NOTIFICATION_CREATED } from '../notifications/notifications.service';

interface MessageEvent {
  data: string;
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
};

const OPERATION_ACTION_MAP: Record<string, ProjectChangeEvent['action']> = {
  insert: 'created',
  update: 'updated',
  replace: 'updated',
  delete: 'deleted',
};

@Controller('events')
export class EventsController implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsController.name);
  private readonly events$ = new Subject<ProjectChangeEvent>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private changeStream: any = null;
  private readonly recentEvents = new Map<string, number>();

  private readonly standalone: boolean;

  constructor(@InjectConnection() private readonly connection: Connection) {
    this.standalone = process.env.MONGODB_STANDALONE === 'true';
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
    const watchedCollections = Object.keys(COLLECTION_ENTITY_MAP);
    const pipeline = [
      { $match: { 'ns.coll': { $in: watchedCollections } } },
    ];

    try {
      const db = this.connection.db;
      if (!db) {
        this.logger.warn('Database not available for Change Streams');
        return;
      }
      this.changeStream = db.watch(pipeline, { fullDocument: 'updateLookup' });

      this.changeStream.on('change', (change: any) => {
        const entity = COLLECTION_ENTITY_MAP[change.ns?.coll];
        const action = OPERATION_ACTION_MAP[change.operationType];
        if (!entity || !action) return;

        let projectId: string | undefined;
        const doc = change.fullDocument || change.documentKey;

        if (entity === 'project') {
          projectId = (doc?._id || change.documentKey?._id)?.toString();
        } else {
          projectId = doc?.projectId?.toString();
        }

        if (!projectId) return;

        const event: ProjectChangeEvent = {
          projectId,
          entity,
          action,
          entityId: (doc?._id || change.documentKey?._id)?.toString(),
        };

        // Deduplicate with EventEmitter events (300ms window)
        const key = `${event.projectId}:${event.entity}:${event.action}:${event.entityId}`;
        const now = Date.now();
        const lastSeen = this.recentEvents.get(key);
        if (lastSeen && now - lastSeen < 300) return;
        this.recentEvents.set(key, now);

        // Cleanup old entries periodically
        if (this.recentEvents.size > 100) {
          for (const [k, t] of this.recentEvents) {
            if (now - t > 5000) this.recentEvents.delete(k);
          }
        }

        this.events$.next(event);
      });

      this.changeStream.on('error', (err: Error) => {
        this.logger.error('Change stream error', err.message);
      });

      this.logger.log('MongoDB Change Stream watching: ' + watchedCollections.join(', '));
    } catch (err) {
      this.logger.warn('Change Streams not available (requires replica set). Falling back to EventEmitter only.');
    }
  }

  @OnEvent(PROJECT_CHANGED)
  handleProjectChange(event: ProjectChangeEvent) {
    // Deduplicate with Change Stream events
    const key = `${event.projectId}:${event.entity}:${event.action}:${event.entityId}`;
    const now = Date.now();
    const lastSeen = this.recentEvents.get(key);
    if (lastSeen && now - lastSeen < 300) return;
    this.recentEvents.set(key, now);

    this.events$.next(event);
  }

  @OnEvent(NOTIFICATION_CREATED)
  handleNotificationCreated(event: { id: string; title: string; body: string }) {
    this.events$.next({
      projectId: '__global__',
      entity: 'notification',
      action: 'created',
      entityId: event.id,
      summary: event.title,
    });
  }

  @Sse()
  sse(@Query('projectId') projectId?: string): Observable<MessageEvent> {
    return this.events$.pipe(
      filter((event) => {
        // Notification events go to ALL clients
        if (event.entity === 'notification') return true;
        if (projectId) return event.projectId === projectId;
        return event.entity === 'project';
      }),
      map((event) => ({ data: JSON.stringify(event) })),
    );
  }
}
