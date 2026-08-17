import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PROJECT_CHANGED, REPLICATION_STATUS_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { SettingsService } from '../settings/settings.service';
import { MinioService } from '../minio/minio.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProjectsService } from '../projects/projects.service';
import { ReplicationQueue, ReplicationQueueDocument } from './schemas/replication-queue.schema';
import {
  REPL_ROLE, REPL_SLAVE_URL, REPL_SLAVE_API_KEY,
  REPL_PEER_URL, REPL_PEER_API_KEY,
  REPL_INSTANCE_ID, REPL_LAST_SYNC, REPL_ENGINE,
  PUSHING_ROLES,
  ReplicationPayload,
  ReplicationRole,
} from './replication.constants';
import { legacyEngineEnabled } from './replication-engine.helpers';
import {
  ReplDoc, asChangeAction, asReplicationRole, chunkToBuffer, errorMessage,
} from './replication-narrow.helpers';
import { asString } from '../common/tool-args';
import { randomUUID } from 'crypto';

/**
 * Maps entity types to MongoDB collection names.
 *
 * NOTE: `workspace` is intentionally absent — workspaces represent local
 * sidecar-container state (clones, scratch files) that is not replicated
 * across instances. Pushed workspace events are silently dropped here
 * (`buildPayload` returns null when the entity has no collection mapping).
 */
const ENTITY_COLLECTION: Record<string, string> = {
  project: 'projects',
  todo: 'todos',
  session: 'sessions',
  knowledge: 'knowledges',
  changelog: 'changelogs',
  milestone: 'milestones',
  manual: 'manuals',
  research: 'researches',
  environment: 'environments',
  secret: 'secrets',
  schema: 'dbschemas',
  dependency: 'dependencies',
  feature: 'features',
  soul: 'souls',
  commit: 'commits',
  'recurring-task': 'recurringtasks',
  snippet: 'snippets',
  attachment: 'attachments',
  activity: 'activities',
  notification: 'notifications',
  release: 'releases',
};

const MAX_ATTEMPTS = 5;
const MAX_QUEUE_SIZE = 1000;

// Notify at most once per hour to avoid spamming the inbox if a peer is down.
const FAILED_NOTIFICATION_DEBOUNCE_MS = 60 * 60 * 1000;

@Injectable()
export class ReplicationPushService {
  private readonly logger = new Logger(ReplicationPushService.name);
  private lastFailedNotifiedCount = 0;
  private lastFailedNotifiedAt = 0;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(ReplicationQueue.name) private queueModel: Model<ReplicationQueueDocument>,
    private settingsService: SettingsService,
    private minioService: MinioService,
    private projectsService: ProjectsService,
    private httpService: HttpService,
    private notificationsService: NotificationsService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Per-project replication opt-in filter. Skips events whose project is not
   * marked for replication. The `project` create event itself is allowed
   * through when its document carries `replicationConfig.enabled=true`,
   * because the project doesn't exist yet at the receiver.
   */
  private async isEventReplicable(event: ProjectChangeEvent): Promise<boolean> {
    if (!event.projectId) return false; // project-less events (activity etc.) never replicate
    if (event.entity === 'project' && event.action === 'created') {
      // The project record's own enabled flag will be checked at receive; here
      // we let it through because the project doesn't exist locally either.
      return true;
    }
    return this.projectsService.isReplicationEnabled(event.projectId).catch(() => false);
  }

  @OnEvent(PROJECT_CHANGED)
  async handleProjectChange(event: ProjectChangeEvent): Promise<void> {
    const role = asReplicationRole(await this.settingsService.get(REPL_ROLE));
    if (!role || !PUSHING_ROLES.has(role)) return;
    // Migration gate: under the log engine the legacy on-emit push+enqueue is
    // off, so the replication_queue never fills (processQueue is off too).
    if (!legacyEngineEnabled(await this.settingsService.get(REPL_ENGINE))) return;
    if (!event.entityId) return;

    // Skip notification events — not worth replicating
    if (event.entity === 'notification') return;

    // T-82: per-project replication opt-in
    if (!(await this.isEventReplicable(event))) return;

    try {
      const payload = await this.buildPayload(event);
      if (!payload) return;

      const sent = await this.pushToPeer(payload, role);
      if (!sent) {
        await this.enqueue(event, payload);
      }
    } catch (err) {
      this.logger.warn(`Replication push failed: ${errorMessage(err)}`);
      try {
        const payload = await this.buildPayload(event);
        if (payload) await this.enqueue(event, payload);
      } catch {
        // If we can't even build the payload, skip
      }
    }
  }

  /** Resolve the peer URL + API key based on the current role.
   *  Master pushes to `slaveUrl`, peer pushes to `peerUrl`. */
  private async getPeerTarget(role: ReplicationRole): Promise<{ url?: string; apiKey?: string }> {
    if (role === 'peer') {
      return {
        url: (await this.settingsService.get(REPL_PEER_URL)) ?? undefined,
        apiKey: (await this.settingsService.get(REPL_PEER_API_KEY)) ?? undefined,
      };
    }
    return {
      url: (await this.settingsService.get(REPL_SLAVE_URL)) ?? undefined,
      apiKey: (await this.settingsService.get(REPL_SLAVE_API_KEY)) ?? undefined,
    };
  }

  private async buildPayload(event: ProjectChangeEvent): Promise<ReplicationPayload | null> {
    const instanceId = await this.getInstanceId();
    let document: Record<string, unknown> | null = null;
    let attachmentData: ReplicationPayload['attachmentData'] | undefined;

    if (event.action !== 'deleted') {
      const collection = ENTITY_COLLECTION[event.entity];
      if (!collection) return null;

      const db = this.connection.db;
      if (!db) return null;

      const { ObjectId } = await import('mongodb');
      // Explizites TSchema: ohne das wäre jedes Feld des gelesenen Dokuments
      // `any` — und dieses Dokument geht 1:1 über die Leitung.
      document = await db.collection<ReplDoc>(collection).findOne({ _id: new ObjectId(event.entityId) });
      if (!document) return null;

      // For attachments, also fetch the binary
      if (event.entity === 'attachment' && this.minioService.isEnabled()) {
        try {
          // `asString` statt `String(...)`: für ein Objekt hätte letzteres
          // "[object Object]" als Storage-Key benutzt.
          const storageKey = asString(document.storageKey) ?? '';
          if (storageKey) {
            const stream = await this.minioService.getObject(storageKey);
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
              chunks.push(chunkToBuffer(chunk));
            }
            const buffer = Buffer.concat(chunks);
            // Only include if < 10MB inline, otherwise will be sent separately
            if (buffer.length < 10 * 1024 * 1024) {
              attachmentData = {
                base64: buffer.toString('base64'),
                fileName: asString(document.originalName) ?? '',
                mimeType: asString(document.mimeType) || 'application/octet-stream',
                storageKey,
              };
            }
          }
        } catch (err) {
          this.logger.warn(`Failed to fetch attachment binary: ${errorMessage(err)}`);
        }
      }
    }

    return {
      event: {
        projectId: event.projectId,
        entity: event.entity,
        action: event.action,
        entityId: event.entityId!,
      },
      document,
      attachmentData,
      timestamp: new Date().toISOString(),
      sourceInstanceId: instanceId,
    };
  }

  /** Push a payload to the configured peer. Works for both master→slave and
   *  peer→peer topologies; role decides which URL to use. */
  private async pushToPeer(payload: ReplicationPayload, role: ReplicationRole): Promise<boolean> {
    const { url, apiKey } = await this.getPeerTarget(role);
    if (!url) return false;

    try {
      await firstValueFrom(
        this.httpService.post(`${url}/api/replication/receive`, payload, {
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          timeout: 30000,
        }),
      );
      await this.settingsService.set(REPL_LAST_SYNC, new Date().toISOString());
      this.eventEmitter.emit(REPLICATION_STATUS_CHANGED);
      return true;
    } catch {
      return false;
    }
  }

  private async enqueue(event: ProjectChangeEvent, payload: ReplicationPayload): Promise<void> {
    const queueSize = await this.queueModel.countDocuments({ status: 'pending' }).exec();
    if (queueSize >= MAX_QUEUE_SIZE) {
      this.logger.warn(`Replication queue overflow (${queueSize}). Full sync required.`);
      return;
    }

    await this.queueModel.create({
      projectId: event.projectId,
      entity: event.entity,
      action: event.action,
      entityId: event.entityId,
      document: payload.document,
      attachmentData: payload.attachmentData,
      status: 'pending',
    });
    this.eventEmitter.emit(REPLICATION_STATUS_CHANGED);
  }

  /** Process queued items — called by scheduler */
  async processQueue(): Promise<number> {
    const role = asReplicationRole(await this.settingsService.get(REPL_ROLE));
    if (!role || !PUSHING_ROLES.has(role)) return 0;

    const items = await this.queueModel
      .find({ status: 'pending' })
      .sort({ createdAt: 1 })
      .limit(50)
      .exec();

    let sent = 0;
    for (const item of items) {
      const instanceId = await this.getInstanceId();
      const payload: ReplicationPayload = {
        event: {
          projectId: item.projectId,
          entity: item.entity,
          // Das Schema erzwingt den Enum; `asChangeAction` bildet einen
          // dennoch unbekannten Wert auf 'updated' ab — genau das Verhalten der
          // Empfängerseite bisher (alles ausser 'deleted' ist ein Upsert). Ein
          // Queue-Eintrag darf hier nicht verworfen werden: er ist die letzte
          // Kopie eines fehlgeschlagenen Pushs.
          action: asChangeAction(item.action),
          entityId: item.entityId,
        },
        document: item.document ?? null,
        attachmentData: item.attachmentData,
        timestamp: new Date().toISOString(),
        sourceInstanceId: instanceId,
      };

      const success = await this.pushToPeer(payload, role);
      if (success) {
        await this.queueModel.findByIdAndUpdate(item._id, { status: 'sent' });
        sent++;
      } else {
        const attempts = item.attempts + 1;
        await this.queueModel.findByIdAndUpdate(item._id, {
          attempts,
          lastAttempt: new Date(),
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
        });
      }
    }

    // Clean up old sent items (older than 24h)
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await this.queueModel.deleteMany({ status: 'sent', createdAt: { $lt: cutoff } }).exec();

    await this.maybeNotifyOnFailures();

    if (items.length > 0) this.eventEmitter.emit(REPLICATION_STATUS_CHANGED);
    return sent;
  }

  /**
   * Fire a single notification when the failed-queue count crosses the
   * debounce threshold. Reset baseline once the failed count drops, so the
   * user gets a fresh ping after they cleared the failed bucket.
   */
  private async maybeNotifyOnFailures(): Promise<void> {
    const failedCount = await this.queueModel.countDocuments({ status: 'failed' }).exec();
    if (failedCount === 0) {
      this.lastFailedNotifiedCount = 0;
      return;
    }
    const now = Date.now();
    const fresh = failedCount > this.lastFailedNotifiedCount;
    const cooledDown = now - this.lastFailedNotifiedAt > FAILED_NOTIFICATION_DEBOUNCE_MS;
    if (!fresh || !cooledDown) return;

    this.lastFailedNotifiedCount = failedCount;
    this.lastFailedNotifiedAt = now;
    void this.notificationsService
      .create(
        `⚠ Replication: ${failedCount} fehlgeschlagen`,
        `${failedCount} Events konnten nach mehreren Versuchen nicht an die Gegenstelle gesendet werden.`,
        '/settings?tab=replication',
        'replication_failed',
      )
      .catch(() => {
        this.logger.warn('Failed to dispatch replication_failed notification');
      });
  }

  async getQueueStats(): Promise<{ pending: number; failed: number }> {
    const [pending, failed] = await Promise.all([
      this.queueModel.countDocuments({ status: 'pending' }).exec(),
      this.queueModel.countDocuments({ status: 'failed' }).exec(),
    ]);
    return { pending, failed };
  }

  async clearFailed(): Promise<number> {
    const result = await this.queueModel.deleteMany({ status: 'failed' }).exec();
    if (result.deletedCount > 0) this.eventEmitter.emit(REPLICATION_STATUS_CHANGED);
    return result.deletedCount;
  }

  private async getInstanceId(): Promise<string> {
    let id = await this.settingsService.get(REPL_INSTANCE_ID);
    if (!id) {
      id = randomUUID();
      await this.settingsService.set(REPL_INSTANCE_ID, id);
    }
    return id;
  }
}
