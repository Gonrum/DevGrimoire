import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { SettingsService } from '../settings/settings.service';
import { MinioService } from '../minio/minio.service';
import { ReplicationQueue, ReplicationQueueDocument } from './schemas/replication-queue.schema';
import {
  REPL_ROLE, REPL_SLAVE_URL, REPL_SLAVE_API_KEY,
  REPL_INSTANCE_ID, REPL_LAST_SYNC,
  ReplicationPayload,
} from './replication.constants';
import { randomUUID } from 'crypto';

/** Maps entity types to MongoDB collection names */
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
  schema: 'schemas',
  dependency: 'dependencies',
  feature: 'features',
  soul: 'souls',
  commit: 'commits',
  'recurring-task': 'recurringtasks',
  snippet: 'snippets',
  attachment: 'attachments',
  activity: 'activities',
  notification: 'notifications',
};

const MAX_ATTEMPTS = 5;
const MAX_QUEUE_SIZE = 1000;

@Injectable()
export class ReplicationPushService {
  private readonly logger = new Logger(ReplicationPushService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(ReplicationQueue.name) private queueModel: Model<ReplicationQueueDocument>,
    private settingsService: SettingsService,
    private minioService: MinioService,
    private httpService: HttpService,
  ) {}

  @OnEvent(PROJECT_CHANGED)
  async handleProjectChange(event: ProjectChangeEvent): Promise<void> {
    const role = await this.settingsService.get(REPL_ROLE);
    if (role !== 'master') return;
    if (!event.entityId) return;

    // Skip notification events — not worth replicating
    if (event.entity === 'notification') return;

    try {
      const payload = await this.buildPayload(event);
      if (!payload) return;

      const sent = await this.pushToSlave(payload);
      if (!sent) {
        await this.enqueue(event, payload);
      }
    } catch (err) {
      this.logger.warn(`Replication push failed: ${(err as Error).message}`);
      try {
        const payload = await this.buildPayload(event);
        if (payload) await this.enqueue(event, payload);
      } catch {
        // If we can't even build the payload, skip
      }
    }
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
      document = await db.collection(collection).findOne({ _id: new ObjectId(event.entityId) }) as Record<string, unknown> | null;
      if (!document) return null;

      // For attachments, also fetch the binary
      if (event.entity === 'attachment' && this.minioService.isEnabled()) {
        try {
          const storageKey = String(document.storageKey || '');
          if (storageKey) {
            const stream = await this.minioService.getObject(storageKey);
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const buffer = Buffer.concat(chunks);
            // Only include if < 10MB inline, otherwise will be sent separately
            if (buffer.length < 10 * 1024 * 1024) {
              attachmentData = {
                base64: buffer.toString('base64'),
                fileName: String(document.originalName || ''),
                mimeType: String(document.mimeType || 'application/octet-stream'),
                storageKey,
              };
            }
          }
        } catch (err) {
          this.logger.warn(`Failed to fetch attachment binary: ${(err as Error).message}`);
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

  private async pushToSlave(payload: ReplicationPayload): Promise<boolean> {
    const slaveUrl = await this.settingsService.get(REPL_SLAVE_URL);
    const apiKey = await this.settingsService.get(REPL_SLAVE_API_KEY);
    if (!slaveUrl) return false;

    try {
      await firstValueFrom(
        this.httpService.post(`${slaveUrl}/api/replication/receive`, payload, {
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          timeout: 30000,
        }),
      );
      await this.settingsService.set(REPL_LAST_SYNC, new Date().toISOString());
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
  }

  /** Process queued items — called by scheduler */
  async processQueue(): Promise<number> {
    const role = await this.settingsService.get(REPL_ROLE);
    if (role !== 'master') return 0;

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
          action: item.action as 'created' | 'updated' | 'deleted',
          entityId: item.entityId,
        },
        document: item.document as Record<string, unknown> | null,
        attachmentData: item.attachmentData as ReplicationPayload['attachmentData'],
        timestamp: new Date().toISOString(),
        sourceInstanceId: instanceId,
      };

      const success = await this.pushToSlave(payload);
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

    return sent;
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
