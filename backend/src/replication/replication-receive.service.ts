import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { isUnknownArray, asString, idToString } from '../common/tool-args';
import { SettingsService } from '../settings/settings.service';
import { MinioService } from '../minio/minio.service';
import { ProjectsService } from '../projects/projects.service';
import { ReplicationPayload, REPL_INSTANCE_ID } from './replication.constants';
import { ReplDoc, errorMessage, isRecord } from './replication-narrow.helpers';
import { ENTITY_COLLECTION } from './replication-collections';


@Injectable()
export class ReplicationReceiveService {
  private readonly logger = new Logger(ReplicationReceiveService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private settingsService: SettingsService,
    private minioService: MinioService,
    private projectsService: ProjectsService,
  ) {}

  /**
   * Decide whether a payload is allowed to be applied based on per-project
   * replication opt-in. Skip-reasons:
   *  - projectId set but the project doesn't exist locally → reject UNLESS
   *    the payload itself is creating that project with enabled=true (bootstrap)
   *  - project exists locally but `replicationConfig.enabled !== true` → reject
   *  - no projectId (global entity like activity log) → never replicated
   */
  private async isProjectReplicated(payload: ReplicationPayload): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    const projectId = payload.event.projectId;
    if (!projectId) {
      return { allowed: false, reason: 'no projectId — global entities are not replicated' };
    }

    // Bootstrap path: incoming `project` create with replicationConfig.enabled=true.
    // `isRecord` ersetzt die bisherige typeof-Prüfung + Assertion und lässt
    // dieselbe Menge Payloads durch (jedes Objekt, auch von einer älteren
    // Gegenstelle mit zusätzlichen Feldern).
    if (payload.event.entity === 'project' && payload.event.action === 'created') {
      const cfg = payload.document?.replicationConfig;
      if (isRecord(cfg) && cfg.enabled === true) return { allowed: true };
    }

    try {
      const enabled = await this.projectsService.isReplicationEnabled(projectId);
      if (!enabled) {
        return { allowed: false, reason: 'project not configured for replication' };
      }
      return { allowed: true };
    } catch {
      // Project doesn't exist locally
      return { allowed: false, reason: 'project does not exist locally — bootstrap required' };
    }
  }

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

    // T-83: per-project replication opt-in check
    const replCheck = await this.isProjectReplicated(payload);
    if (!replCheck.allowed) {
      this.logger.debug(
        `Skipped replication apply (${payload.event.entity}/${payload.event.entityId}): ${replCheck.reason}`,
      );
      return { applied: false, reason: replCheck.reason };
    }

    const { ObjectId } = await import('mongodb');
    // Explizites TSchema: ohne das ist jedes Feld des gelesenen Dokuments `any`
    // — und das ausgerechnet an der Grenze zu einer fremden Instanz. `ReplDoc`
    // hält die Form bewusst offen (jedes Feld optional, `unknown`), verengt also
    // nichts, erzwingt aber eine Prüfung pro Feldzugriff.
    const coll = db.collection<ReplDoc>(collection);

    try {
      if (payload.event.action === 'deleted') {
        await coll.deleteOne({ _id: new ObjectId(payload.event.entityId) });

        // For attachments, also remove from MinIO
        if (payload.event.entity === 'attachment' && this.minioService.isEnabled()) {
          // We need the storageKey — it might be in the document or we need to look it up
          // Since it's a delete, the document was already deleted. The storageKey should be in the payload if available.
          const storageKey = asString(payload.document?.storageKey);
          if (storageKey) {
            await this.minioService.removeObject(storageKey).catch((err: unknown) =>
              this.logger.warn(`MinIO delete failed: ${errorMessage(err)}`),
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

      // T-89: Last-Write-Wins. Compare the local doc's updatedAt against the
      // incoming doc's updatedAt. If local is newer, drop this change. If
      // either side has no timestamp, default to applying (defensive — better
      // to overwrite an undated doc than to silently lose updates).
      const incomingDoc = payload.document;
      const incomingTs = this.parseTimestamp(incomingDoc.updatedAt);
      if (incomingTs) {
        const local = await coll.findOne(
          { _id: new ObjectId(payload.event.entityId) },
          { projection: { updatedAt: 1 } },
        );
        const localTs = local ? this.parseTimestamp(local.updatedAt) : null;
        if (localTs && localTs > incomingTs) {
          this.logger.debug(
            `LWW skipped: local ${payload.event.entity}/${payload.event.entityId} is newer (${localTs.toISOString()} > ${incomingTs.toISOString()})`,
          );
          return { applied: false, reason: 'LWW: local version is newer' };
        }
      }

      // Prepare document for upsert — convert _id string to ObjectId.
      // `payload.document` ist JSON aus dem Request-Body (kein Mongoose-Dokument),
      // die flache Kopie enthält also wirklich alle Felder.
      const doc: Record<string, unknown> = { ...payload.document };
      const docId = doc._id;
      delete doc._id;

      // Convert known ObjectId fields. Die Truthiness-Prüfung bleibt vor dem
      // typeof stehen: ein leerer String darf nicht in `new ObjectId('')`
      // laufen (das wirft), sondern bleibt wie bisher unverändert.
      if (doc.projectId && typeof doc.projectId === 'string') {
        doc.projectId = new ObjectId(doc.projectId);
      }
      if (doc.milestoneId && typeof doc.milestoneId === 'string') {
        doc.milestoneId = new ObjectId(doc.milestoneId);
      }
      if (doc.entityId && typeof doc.entityId === 'string' && payload.event.entity === 'attachment') {
        doc.entityId = new ObjectId(doc.entityId);
      }
      if (isUnknownArray(doc.blockedBy)) {
        // Wie bisher: nur Strings werden gecastet, alles andere bleibt
        // unverändert stehen (vorher über den catch-Zweig, jetzt über die
        // typeof-Prüfung — gleiche Menge, gleiche Reihenfolge, gleiche Länge).
        doc.blockedBy = doc.blockedBy.map((id) => {
          if (typeof id !== 'string') return id;
          try { return new ObjectId(id); } catch { return id; }
        });
      }
      this.normalizeTimestamps(doc);

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
      this.logger.error(`Replication apply failed: ${errorMessage(err)}`);
      return { applied: false, reason: errorMessage(err) };
    }
  }

  /**
   * Parse a Mongo `updatedAt` value into a Date. Mongo serializes dates as
   * ISO strings over JSON; if a Date object slips through, we accept it too.
   * Returns null on missing/unparseable values so the caller can decide to
   * default to "apply" rather than crashing the replication pipeline.
   */
  private parseTimestamp(value: unknown): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'string' || typeof value === 'number') {
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  /**
   * Mutate in place: convert ISO-string timestamps (from JSON transport) back
   * to real Date objects. Without this, BSON type comparison breaks the pull
   * endpoint's `updatedAt: { $gt: Date }` filter — strings never compare as
   * greater-than dates, so all replicated children become invisible to pull.
   */
  private normalizeTimestamps(doc: Record<string, unknown>): void {
    for (const field of ['createdAt', 'updatedAt', 'timestamp', 'expiresAt', 'lastUsedAt']) {
      const v = doc[field];
      if (typeof v === 'string') {
        const d = new Date(v);
        if (!isNaN(d.getTime())) doc[field] = d;
      }
    }
  }

  /** Apply a full project sync — upsert all documents, remove stale ones */
  async applyFullSync(
    projectExport: Record<string, unknown>,
  ): Promise<{ entities: number; errors: number; skipped: number }> {
    const db = this.connection.db;
    if (!db) return { entities: 0, errors: 0, skipped: 0 };

    const { ObjectId } = await import('mongodb');
    let entities = 0;
    let errors = 0;
    let skipped = 0;

    // Collections without an `updatedAt` field (append-only or timestamped via
    // different fields) — always upsert without LWW check.
    const lwwExemptCollections = new Set(['activities', 'commits']);

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
      schemas: 'dbschemas',
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

    for (const [key, collectionName] of Object.entries(exportCollectionMap)) {
      const data = projectExport[key];
      if (!data) continue;

      const coll = db.collection<ReplDoc>(collectionName);
      // `isUnknownArray` statt `Array.isArray`: letzteres verengt ein `unknown`
      // zu `any[]` und macht damit jedes Element wieder ungeprüft.
      const docs: unknown[] = isUnknownArray(data) ? data : [data];

      for (const rawDoc of docs) {
        try {
          // Verhalten 1:1 wie vorher: `null`/`undefined` liess `doc._id` eine
          // TypeError werfen → errors++ mit Warnung (bleibt laut). Ein Primitive
          // ergab `doc._id === undefined` → stiller `continue` (bleibt still).
          if (rawDoc == null) throw new Error('null document in full-sync export');
          if (!isRecord(rawDoc)) continue;
          const rawId = rawDoc._id;
          if (!rawId) continue;
          // Vorher `new ObjectId(String(id))`: ein nicht lesbares `_id` wurde zu
          // "[object Object]" und liess `new ObjectId` werfen → errors++. Genau
          // dieses laute Scheitern bleibt (statt still zu überspringen).
          const id = idToString(rawId);
          if (!id) throw new Error('unusable _id in full-sync document');

          const cleanDoc: Record<string, unknown> = { ...rawDoc };
          delete cleanDoc._id;

          // Convert string ObjectIds (Truthiness-Prüfung wie oben: '' wirft)
          if (cleanDoc.projectId && typeof cleanDoc.projectId === 'string') {
            cleanDoc.projectId = new ObjectId(cleanDoc.projectId);
          }
          this.normalizeTimestamps(cleanDoc);

          // LWW: skip upsert when the local doc has a newer `updatedAt` than
          // the incoming snapshot. Without this, a scheduled full-sync from an
          // instance with stale live-push queue would overwrite edits made on
          // the receiving side. Mirrors the check in applyChange().
          const docObjectId = new ObjectId(id);
          if (!lwwExemptCollections.has(collectionName)) {
            const incomingTs = this.parseTimestamp(cleanDoc.updatedAt);
            if (incomingTs) {
              const local = await coll.findOne(
                { _id: docObjectId },
                { projection: { updatedAt: 1 } },
              );
              const localTs = local ? this.parseTimestamp(local.updatedAt) : null;
              if (localTs && localTs > incomingTs) {
                skipped++;
                continue;
              }
            }
          }

          await coll.replaceOne(
            { _id: docObjectId },
            cleanDoc,
            { upsert: true },
          );
          entities++;

          // Handle attachment binary. Ein vorhandenes, aber nicht string-artiges
          // `_binaryBase64` (bzw. ein fehlender storageKey) wirft weiter statt
          // still den Anhang zu überspringen: das landet im catch unten als
          // errors++ mit Warnung, wie vorher über `Buffer.from`/putObject.
          if (key === 'attachments' && cleanDoc._binaryBase64 && this.minioService.isEnabled()) {
            const base64 = asString(cleanDoc._binaryBase64);
            const storageKey = asString(cleanDoc.storageKey);
            if (!base64) throw new Error('attachment _binaryBase64 is not a string');
            if (!storageKey) throw new Error('attachment has no storageKey');
            const buffer = Buffer.from(base64, 'base64');
            await this.minioService.putObject(
              storageKey,
              buffer,
              asString(cleanDoc.mimeType) || 'application/octet-stream',
            );
          }
        } catch (err) {
          this.logger.warn(`Full sync upsert failed: ${errorMessage(err)}`);
          errors++;
        }
      }
    }

    return { entities, errors, skipped };
  }
}
