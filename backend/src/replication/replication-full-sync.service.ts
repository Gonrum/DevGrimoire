import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { SettingsService } from '../settings/settings.service';
import { MinioService } from '../minio/minio.service';
import {
  REPL_ROLE, REPL_SLAVE_URL, REPL_SLAVE_API_KEY,
  REPL_PEER_URL, REPL_PEER_API_KEY,
  REPL_LAST_FULL_SYNC, REPL_INSTANCE_ID,
  PUSHING_ROLES,
  ReplicationRole,
} from './replication.constants';
import { randomUUID } from 'crypto';

/** All collections to sync, grouped by export key */
const SYNC_COLLECTIONS: Record<string, string> = {
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
  releases: 'releases',
};

@Injectable()
export class ReplicationFullSyncService {
  private readonly logger = new Logger(ReplicationFullSyncService.name);
  private syncing = false;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private settingsService: SettingsService,
    private minioService: MinioService,
    private httpService: HttpService,
  ) {}

  /** Run full sync from master→slave or peer→peer. */
  async runFullSync(): Promise<{ projects: number; entities: number; errors: number }> {
    const role = (await this.settingsService.get(REPL_ROLE)) as ReplicationRole | null;
    if (!role || !PUSHING_ROLES.has(role)) return { projects: 0, entities: 0, errors: 0 };
    if (this.syncing) {
      this.logger.warn('Full sync already in progress');
      return { projects: 0, entities: 0, errors: 0 };
    }

    this.syncing = true;
    const peerUrl = role === 'peer'
      ? await this.settingsService.get(REPL_PEER_URL)
      : await this.settingsService.get(REPL_SLAVE_URL);
    const apiKey = role === 'peer'
      ? await this.settingsService.get(REPL_PEER_API_KEY)
      : await this.settingsService.get(REPL_SLAVE_API_KEY);
    if (!peerUrl) {
      this.syncing = false;
      return { projects: 0, entities: 0, errors: 0 };
    }

    this.logger.log('Starting full sync...');
    const db = this.connection.db;
    if (!db) {
      this.syncing = false;
      return { projects: 0, entities: 0, errors: 0 };
    }

    let totalProjects = 0;
    let totalEntities = 0;
    let totalErrors = 0;

    try {
      const { ObjectId } = await import('mongodb');
      // T-84: only sync projects that have explicitly opted in to replication.
      // This prevents leaking private projects when a peer is configured.
      const projects = await db.collection('projects')
        .find({ 'replicationConfig.enabled': true })
        .toArray();

      for (const project of projects) {
        const projectId = project._id;
        const exportData: Record<string, unknown> = {
          project: project,
        };

        // Fetch all entities for this project. projectId is stored as ObjectId
        // by some services and as string by others (notably MCP-tool-created
        // documents). Mongo's raw .find() does not auto-cast, so we $in both
        // representations to catch every document. Without this the full-sync
        // would only ship the project document itself.
        const projectIdOid = new ObjectId(String(projectId));
        const projectIdStr = String(projectId);
        for (const [key, collName] of Object.entries(SYNC_COLLECTIONS)) {
          try {
            const docs = await db.collection(collName)
              .find({ projectId: { $in: [projectIdOid, projectIdStr] } })
              .toArray();

            // For attachments, include binary data if MinIO is available
            if (key === 'attachments' && this.minioService.isEnabled()) {
              for (const doc of docs) {
                try {
                  const storageKey = String(doc.storageKey || '');
                  if (storageKey && (doc.size as number) < 10 * 1024 * 1024) {
                    const stream = await this.minioService.getObject(storageKey);
                    const chunks: Buffer[] = [];
                    for await (const chunk of stream) {
                      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    }
                    (doc as any)._binaryBase64 = Buffer.concat(chunks).toString('base64');
                  }
                } catch {
                  // Skip binary if fetch fails
                }
              }
            }

            exportData[key] = docs;
          } catch {
            // Collection may not exist yet
            exportData[key] = [];
          }
        }

        // Send to peer (slave or peer-peer)
        try {
          const result = await firstValueFrom(
            this.httpService.post(`${peerUrl}/api/replication/full-sync`, exportData, {
              headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
              },
              timeout: 120000,
              maxContentLength: 500 * 1024 * 1024,
              maxBodyLength: 500 * 1024 * 1024,
            }),
          );
          totalEntities += (result.data as any)?.entities || 0;
          totalErrors += (result.data as any)?.errors || 0;
          totalProjects++;
        } catch (err) {
          this.logger.error(`Full sync failed for project ${projectId}: ${(err as Error).message}`);
          totalErrors++;
        }
      }

      await this.settingsService.set(REPL_LAST_FULL_SYNC, new Date().toISOString());
      this.logger.log(`Full sync completed: ${totalProjects} projects, ${totalEntities} entities, ${totalErrors} errors`);
    } catch (err) {
      this.logger.error(`Full sync failed: ${(err as Error).message}`);
    } finally {
      this.syncing = false;
    }

    return { projects: totalProjects, entities: totalEntities, errors: totalErrors };
  }

  isSyncing(): boolean {
    return this.syncing;
  }
}
