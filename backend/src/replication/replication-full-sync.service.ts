import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, mongo } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { REPLICATION_STATUS_CHANGED } from '../events/project-event';
import { SettingsService } from '../settings/settings.service';
import { MinioService } from '../minio/minio.service';
import {
  REPL_ROLE, REPL_SLAVE_URL, REPL_SLAVE_API_KEY,
  REPL_PEER_URL, REPL_PEER_API_KEY,
  REPL_LAST_FULL_SYNC,
  PUSHING_ROLES,
} from './replication.constants';
import {
  ReplDoc, asCount, asReplicationRole, chunkToBuffer, errorMessage,
} from './replication-narrow.helpers';
import { idToString } from '../common/tool-args';
import { EXPORT_COLLECTION } from './replication-collections';

/** Was die Gegenstelle auf einen Full-Sync-Post antwortet. Die Felder sind
 *  bewusst `unknown`: eine ältere/andere Version darf hier alles schicken, und
 *  `asCount()` entscheidet zur Laufzeit, was als Zahl zählt. */
interface FullSyncAck {
  entities?: unknown;
  errors?: unknown;
  skipped?: unknown;
}


@Injectable()
export class ReplicationFullSyncService {
  private readonly logger = new Logger(ReplicationFullSyncService.name);
  private syncing = false;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private settingsService: SettingsService,
    private minioService: MinioService,
    private httpService: HttpService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Run full sync from master→slave or peer→peer.
   *
   * @param projectId optional filter — if set, only sync that single project
   *   (must still be `replicationConfig.enabled=true` — otherwise early return
   *   to avoid leaking non-opted-in data). Without the filter, iterate all
   *   enabled projects like before.
   */
  async runFullSync(onlyProjectId?: string): Promise<{ projects: number; entities: number; errors: number; skipped: number }> {
    const role = asReplicationRole(await this.settingsService.get(REPL_ROLE));
    if (!role || !PUSHING_ROLES.has(role)) return { projects: 0, entities: 0, errors: 0, skipped: 0 };
    if (this.syncing) {
      this.logger.warn('Full sync already in progress');
      return { projects: 0, entities: 0, errors: 0, skipped: 0 };
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
      return { projects: 0, entities: 0, errors: 0, skipped: 0 };
    }

    this.logger.log('Starting full sync...');
    const db = this.connection.db;
    if (!db) {
      this.syncing = false;
      return { projects: 0, entities: 0, errors: 0, skipped: 0 };
    }

    let totalProjects = 0;
    let totalEntities = 0;
    let totalErrors = 0;
    let totalSkipped = 0;

    try {
      const { ObjectId } = await import('mongodb');
      // T-84: only sync projects that have explicitly opted in to replication.
      // This prevents leaking private projects when a peer is configured.
      // If a specific projectId was supplied (T-94 single-project trigger),
      // narrow to that one — still enforcing the enabled flag to prevent
      // accidental leaks via a misuse of the single-project path.
      const filter: mongo.Filter<ReplDoc> = { 'replicationConfig.enabled': true };
      if (onlyProjectId) {
        try {
          filter._id = new ObjectId(onlyProjectId);
        } catch {
          this.logger.warn(`runFullSync: invalid projectId "${onlyProjectId}", ignoring`);
          this.syncing = false;
          return { projects: 0, entities: 0, errors: 0, skipped: 0 };
        }
      }
      // Explizites TSchema (`ReplDoc`): sonst ist jedes Feld ausser `_id` `any`.
      const projects = await db.collection<ReplDoc>('projects').find(filter).toArray();

      for (const project of projects) {
        // `_id` ist in einem gelesenen Mongo-Dokument immer vorhanden; die
        // Prüfung ist reine Absicherung. Ohne sie wäre `new ObjectId(undefined)`
        // eine NEU generierte Id — der Full-Sync würde stumm ein falsches
        // Projekt exportieren.
        const projectIdStr = idToString(project._id);
        if (!projectIdStr) {
          this.logger.warn('runFullSync: project document without usable _id — skipped');
          totalErrors++;
          continue;
        }
        const exportData: Record<string, unknown> = {
          project: project,
        };

        // Fetch all entities for this project. projectId is stored as ObjectId
        // by some services and as string by others (notably MCP-tool-created
        // documents). Mongo's raw .find() does not auto-cast, so we $in both
        // representations to catch every document. Without this the full-sync
        // would only ship the project document itself.
        const projectIdOid = new ObjectId(projectIdStr);
        for (const [key, collName] of Object.entries(EXPORT_COLLECTION)) {
          // Das Projekt-Dokument selbst hängt schon unter `project` am Export.
          // In der Schleife würde `projects` nach einem `projectId`-Feld
          // durchsucht, das es dort nicht gibt.
          if (collName === 'projects') continue;
          try {
            const docs = await db.collection<ReplDoc>(collName)
              .find({ projectId: { $in: [projectIdOid, projectIdStr] } })
              .toArray();

            // For attachments, include binary data if MinIO is available
            if (key === 'attachments' && this.minioService.isEnabled()) {
              for (const doc of docs) {
                try {
                  const storageKey = typeof doc.storageKey === 'string' ? doc.storageKey : '';
                  // `Number(...)` reproduziert exakt die Koerzierung, die der
                  // Vergleich `doc.size < 10MB` vorher selbst gemacht hat:
                  // fehlend → NaN → false, "1000" → 1000 → true. Eine reine
                  // `typeof === 'number'`-Prüfung hätte einen stringifizierten
                  // `size` (und damit dessen Binary) still fallen lassen.
                  const size = Number(doc.size);
                  if (storageKey && size < 10 * 1024 * 1024) {
                    const stream = await this.minioService.getObject(storageKey);
                    const chunks: Buffer[] = [];
                    for await (const chunk of stream) {
                      chunks.push(chunkToBuffer(chunk));
                    }
                    doc._binaryBase64 = Buffer.concat(chunks).toString('base64');
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
            this.httpService.post<FullSyncAck>(`${peerUrl}/api/replication/full-sync`, exportData, {
              headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
              },
              timeout: 120000,
              maxContentLength: 500 * 1024 * 1024,
              maxBodyLength: 500 * 1024 * 1024,
            }),
          );
          // `asCount` statt `|| 0`: ein stringifizierter Zähler ("5") hätte
          // über `+=` aus der Summe einen String gemacht ("05") und alle
          // Folgezählungen verfälscht.
          totalEntities += asCount(result.data?.entities);
          totalErrors += asCount(result.data?.errors);
          totalSkipped += asCount(result.data?.skipped);
          totalProjects++;
        } catch (err) {
          this.logger.error(`Full sync failed for project ${projectIdStr}: ${errorMessage(err)}`);
          totalErrors++;
        }
      }

      await this.settingsService.set(REPL_LAST_FULL_SYNC, new Date().toISOString());
      this.eventEmitter.emit(REPLICATION_STATUS_CHANGED);
      this.logger.log(`Full sync completed: ${totalProjects} projects, ${totalEntities} entities, ${totalSkipped} LWW-skipped, ${totalErrors} errors`);
    } catch (err) {
      this.logger.error(`Full sync failed: ${errorMessage(err)}`);
    } finally {
      this.syncing = false;
    }

    return { projects: totalProjects, entities: totalEntities, errors: totalErrors, skipped: totalSkipped };
  }

  isSyncing(): boolean {
    return this.syncing;
  }
}
