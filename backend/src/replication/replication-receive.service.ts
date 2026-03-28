import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { SettingsService } from '../settings/settings.service';
import { MinioService } from '../minio/minio.service';
import { ReplicationPayload, REPL_INSTANCE_ID } from './replication.constants';

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
};

@Injectable()
export class ReplicationReceiveService {
  private readonly logger = new Logger(ReplicationReceiveService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private settingsService: SettingsService,
    private minioService: MinioService,
  ) {}

  async applyChange(payload: ReplicationPayload): Promise<{ applied: boolean; reason?: string }> {
    // Check for echo prevention
    const myId = await this.settingsService.get(REPL_INSTANCE_ID);
    if (myId && payload.sourceInstanceId === myId) {
      return { applied: false, reason: 'Same instance — skipped' };
    }

    const collection = ENTITY_COLLECTION[payload.event.entity];
    if (!collection) {
      return { applied: false, reason: `Unknown entity type: ${payload.event.entity}` };
    }

    const db = this.connection.db;
    if (!db) {
      return { applied: false, reason: 'Database not available' };
    }

    const { ObjectId } = await import('mongodb');
    const coll = db.collection(collection);

    try {
      if (payload.event.action === 'deleted') {
        await coll.deleteOne({ _id: new ObjectId(payload.event.entityId) });

        // For attachments, also remove from MinIO
        if (payload.event.entity === 'attachment' && this.minioService.isEnabled()) {
          // We need the storageKey — it might be in the document or we need to look it up
          // Since it's a delete, the document was already deleted. The storageKey should be in the payload if available.
          if (payload.document?.storageKey) {
            await this.minioService.removeObject(String(payload.document.storageKey)).catch((err) =>
              this.logger.warn(`MinIO delete failed: ${(err as Error).message}`),
            );
          }
        }

        this.logger.debug(`Replicated delete: ${payload.event.entity}/${payload.event.entityId}`);
        return { applied: true };
      }

      // Created or updated — upsert
      if (!payload.document) {
        return { applied: false, reason: 'No document in payload for create/update' };
      }

      // Prepare document for upsert — convert _id string to ObjectId
      const doc = { ...payload.document };
      const docId = doc._id;
      delete doc._id;

      // Convert known ObjectId fields
      if (doc.projectId && typeof doc.projectId === 'string') {
        doc.projectId = new ObjectId(doc.projectId);
      }
      if (doc.milestoneId && typeof doc.milestoneId === 'string') {
        doc.milestoneId = new ObjectId(doc.milestoneId);
      }
      if (doc.entityId && typeof doc.entityId === 'string' && payload.event.entity === 'attachment') {
        doc.entityId = new ObjectId(doc.entityId);
      }
      if (Array.isArray(doc.blockedBy)) {
        doc.blockedBy = (doc.blockedBy as string[]).map((id) => {
          try { return new ObjectId(id); } catch { return id; }
        });
      }

      await coll.replaceOne(
        { _id: new ObjectId(String(docId)) },
        doc,
        { upsert: true },
      );

      // For attachments, also write binary to MinIO
      if (payload.event.entity === 'attachment' && payload.attachmentData && this.minioService.isEnabled()) {
        const buffer = Buffer.from(payload.attachmentData.base64, 'base64');
        await this.minioService.putObject(
          payload.attachmentData.storageKey,
          buffer,
          payload.attachmentData.mimeType,
        );
      }

      this.logger.debug(`Replicated ${payload.event.action}: ${payload.event.entity}/${payload.event.entityId}`);
      return { applied: true };
    } catch (err) {
      this.logger.error(`Replication apply failed: ${(err as Error).message}`);
      return { applied: false, reason: (err as Error).message };
    }
  }

  /** Apply a full project sync — upsert all documents, remove stale ones */
  async applyFullSync(
    projectExport: Record<string, unknown>,
  ): Promise<{ entities: number; errors: number }> {
    const db = this.connection.db;
    if (!db) return { entities: 0, errors: 0 };

    const { ObjectId } = await import('mongodb');
    let entities = 0;
    let errors = 0;

    // Map of export key → collection name
    const exportCollectionMap: Record<string, string> = {
      project: 'projects',
      todos: 'todos',
      sessions: 'sessions',
      knowledge: 'knowledges',
      changelog: 'changelogs',
      milestones: 'milestones',
      manuals: 'manuals',
      research: 'researches',
      environments: 'environments',
      secrets: 'secrets',
      schemas: 'schemas',
      dependencies: 'dependencies',
      features: 'features',
      souls: 'souls',
      commits: 'commits',
      recurringTasks: 'recurringtasks',
      snippets: 'snippets',
      attachments: 'attachments',
      activities: 'activities',
    };

    for (const [key, collectionName] of Object.entries(exportCollectionMap)) {
      const data = projectExport[key];
      if (!data) continue;

      const coll = db.collection(collectionName);
      const docs = Array.isArray(data) ? data : [data];

      for (const doc of docs) {
        try {
          const id = doc._id;
          if (!id) continue;

          const cleanDoc = { ...doc };
          delete cleanDoc._id;

          // Convert string ObjectIds
          if (cleanDoc.projectId && typeof cleanDoc.projectId === 'string') {
            cleanDoc.projectId = new ObjectId(cleanDoc.projectId);
          }

          await coll.replaceOne(
            { _id: new ObjectId(String(id)) },
            cleanDoc,
            { upsert: true },
          );
          entities++;

          // Handle attachment binary
          if (key === 'attachments' && cleanDoc._binaryBase64 && this.minioService.isEnabled()) {
            const buffer = Buffer.from(cleanDoc._binaryBase64 as string, 'base64');
            await this.minioService.putObject(
              String(cleanDoc.storageKey),
              buffer,
              String(cleanDoc.mimeType || 'application/octet-stream'),
            );
          }
        } catch (err) {
          this.logger.warn(`Full sync upsert failed: ${(err as Error).message}`);
          errors++;
        }
      }
    }

    return { entities, errors };
  }
}
