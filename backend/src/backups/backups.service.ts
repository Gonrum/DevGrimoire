import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { errorMessage, isRecord, isUnknownArray, streamToBuffer } from '../common/narrow';
import { Cron } from '@nestjs/schedule';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, mongo } from 'mongoose';
import { createHash } from 'crypto';
import { createGzip, gunzipSync } from 'zlib';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BackupJob, BackupJobDocument, BackupMode, BackupStatus } from './schemas/backup-job.schema';
import { CreateBackupDto } from './dto/create-backup.dto';
import { MinioService } from '../minio/minio.service';
import { NotificationsService } from '../notifications/notifications.service';

interface BackupArtifact {
  key: string;
  size: number;
  sha256: string;
  contentType: string;
}

/**
 * Artefaktliste aus einem Mixed-Feld bzw. einer eingelesenen Manifest-Datei.
 *
 * Beide Quellen sind ungeprüft: `BackupJob.manifest` ist `Record<string,
 * unknown>`, die Manifest-Datei kommt aus dem Objektspeicher. Vorher stand an
 * beiden Stellen `Array.isArray(x) ? x as BackupArtifact[] : []` — die Prüfung
 * galt dem Array, behauptet wurde der Elementtyp.
 */
function artifactsOf(value: unknown): BackupArtifact[] {
  if (!isUnknownArray(value)) return [];
  return value.filter((entry): entry is BackupArtifact =>
    isRecord(entry) &&
    typeof entry.key === 'string' &&
    typeof entry.size === 'number' &&
    typeof entry.sha256 === 'string' &&
    typeof entry.contentType === 'string');
}

interface RetentionCandidate {
  jobId: string;
  createdAt?: Date;
  bucket: string;
  objectPrefix?: string;
  artifactKeys: string[];
  status: BackupStatus;
}

const RETENTION_CONFIRMATION = 'DELETE_EXPIRED_BACKUPS';

/**
 * Collections, die nie ins Backup gehören (H-37). `refreshtokens` sind live
 * einlösbare Sessions — als Hash zwar nicht mehr direkt nutzbar (H-8), aber
 * ein Restore soll ohnehin keine alten Sessions wiederbeleben.
 */
const EXCLUDED_BACKUP_COLLECTIONS: string[] = ['refreshtokens'];

/** Ehrliche Aufzählung des Credential-Materials im Dump, fürs Manifest. */
const CREDENTIAL_MATERIAL_ITEMS: string[] = [
  'users.passwordHash (bcrypt) — Offline-Cracking-Material',
  'secrets.encryptedValue (AES-256-GCM, SECRETS_ENCRYPTION_KEY)',
  'settings replication.*.apiKey (AES-256-GCM; Klartext, falls SECRETS_ENCRYPTION_KEY fehlt)',
  'settings chat/rag/web-search endpoint keys (AES-256-GCM)',
  'apikeys.keyHash (SHA-256, nicht umkehrbar)',
];

@Injectable()
export class BackupsService implements OnModuleInit {
  private readonly logger = new Logger(BackupsService.name);
  private running = false;

  /**
   * Jobs, die beim Start noch auf `running` stehen, gehören zu einem Prozess,
   * der nicht mehr lebt (`this.running` ist ein In-Memory-Flag). Ohne diesen
   * Aufräumschritt blieben sie für immer `running` — live am 2026-10-12: vier
   * Jobs vom Juli, das Bild eines Absturzes mitten im (damals noch
   * vollständig gepufferten) Dump (H-36). Läuft genau einmal pro Prozessstart,
   * bevor ein neuer Job entstehen kann.
   */
  async onModuleInit(): Promise<void> {
    try {
      const res = await this.backupJobModel
        .updateMany(
          { status: BackupStatus.RUNNING },
          {
            $set: {
              status: BackupStatus.FAILED,
              error: 'interrupted: Backend wurde während des Backups beendet',
              finishedAt: new Date(),
            },
          },
        )
        .exec();
      if (res.modifiedCount > 0) {
        this.logger.warn(`${res.modifiedCount} unterbrochene Backup-Job(s) als failed markiert`);
      }
    } catch (err: unknown) {
      this.logger.error(`Aufräumen unterbrochener Backup-Jobs fehlgeschlagen: ${errorMessage(err)}`);
    }
  }

  constructor(
    @InjectModel(BackupJob.name) private backupJobModel: Model<BackupJobDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly minioService: MinioService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async createManualBackup(dto: CreateBackupDto): Promise<BackupJobDocument> {
    return this.createBackup({
      trigger: 'manual',
      mode: dto.mode || BackupMode.FULL_SYSTEM,
      includeAttachments: dto.includeAttachments,
    });
  }

  /** Daily full-system backup at 06:00 server time. */
  @Cron(process.env.BACKUP_CRON || '0 6 * * *')
  async createScheduledBackup(): Promise<void> {
    if (process.env.BACKUP_DAILY_ENABLED === 'false') return;
    try {
      await this.createBackup({ trigger: 'scheduled', mode: BackupMode.FULL_SYSTEM });
    } catch (err) {
      this.logger.error(`Scheduled backup failed: ${errorMessage(err)}`);
    }
  }

  async findAll(limit = 50): Promise<BackupJobDocument[]> {
    return this.backupJobModel.find().sort({ createdAt: -1 }).limit(Math.min(limit, 200)).exec();
  }

  async findById(id: string): Promise<BackupJobDocument> {
    const job = await this.backupJobModel.findById(id).exec();
    if (!job) throw new NotFoundException(`Backup job ${id} not found`);
    return job;
  }

  getStatus(): Record<string, unknown> {
    return {
      enabled: process.env.BACKUP_DAILY_ENABLED !== 'false',
      schedule: process.env.BACKUP_CRON || '0 6 * * *',
      bucket: this.getBackupBucket(),
      minioEnabled: this.minioService.isEnabled(),
      running: this.running,
      retention: this.getRetentionPolicy(),
    };
  }

  async previewRetention(): Promise<Record<string, unknown>> {
    const policy = this.getRetentionPolicy();
    const candidates = await this.getRetentionCandidates(policy.keepLast, policy.keepDays);
    return this.buildRetentionReport(policy, candidates, true, 'Preview only. No backup jobs or objects were deleted.');
  }

  async applyRetention(confirm: string): Promise<Record<string, unknown>> {
    if (confirm !== RETENTION_CONFIRMATION) {
      throw new BadRequestException(`Retention cleanup requires confirm="${RETENTION_CONFIRMATION}"`);
    }
    if (!this.minioService.isEnabled()) throw new BadRequestException('MinIO is not configured; retention cleanup needs backup storage');

    const policy = this.getRetentionPolicy();
    const candidates = await this.getRetentionCandidates(policy.keepLast, policy.keepDays);
    const deletedObjects: string[] = [];
    const errors: Array<{ jobId: string; message: string }> = [];

    for (const candidate of candidates) {
      try {
        await this.minioService.removeObjectsInBucket(candidate.bucket, candidate.artifactKeys);
        deletedObjects.push(...candidate.artifactKeys);
        await this.backupJobModel.findByIdAndDelete(candidate.jobId).exec();
      } catch (err) {
        errors.push({ jobId: candidate.jobId, message: errorMessage(err) });
      }
    }

    return {
      ...this.buildRetentionReport(policy, candidates, false, 'Expired backup jobs and listed objects were removed.'),
      deletedObjectCount: deletedObjects.length,
      errors,
      ok: errors.length === 0,
    };
  }

  async previewRestore(id: string): Promise<Record<string, unknown>> {
    if (!this.minioService.isEnabled()) throw new BadRequestException('MinIO is not configured; restore preview needs backup storage');
    const job = await this.findById(id);
    if (job.status !== BackupStatus.COMPLETED) {
      throw new BadRequestException(`Backup job ${id} is not completed`);
    }

    const manifestKey = `${job.objectPrefix}/manifest.json`;
    const manifestRaw = await this.readJsonObject(job.bucket, manifestKey);
    const manifest = isRecord(manifestRaw) ? manifestRaw : {};
    const artifacts = artifactsOf(manifest.artifacts);
    const checks = await Promise.all(artifacts.map(async (artifact) => this.verifyArtifact(job.bucket, artifact)));

    return {
      jobId: job._id.toString(),
      status: job.status,
      bucket: job.bucket,
      objectPrefix: job.objectPrefix,
      manifestKey,
      manifestFormat: typeof manifest.format === 'string' ? manifest.format : null,
      includes: isRecord(manifest.includes) ? manifest.includes : {},
      artifactCount: artifacts.length,
      checks,
      ok: checks.every((check) => check.exists && check.sizeMatches && check.sha256Matches),
      note: 'Restore preview only. No database or attachment data was modified.',
    };
  }

  private async createBackup(options: {
    trigger: 'manual' | 'scheduled';
    mode: BackupMode;
    includeAttachments?: boolean;
  }): Promise<BackupJobDocument> {
    if (this.running) throw new BadRequestException('A backup is already running');
    if (!this.minioService.isEnabled()) throw new BadRequestException('MinIO is not configured; backups need MinIO/S3 storage');

    this.running = true;
    const startedAt = new Date();
    const bucket = this.getBackupBucket();
    const objectPrefix = this.buildObjectPrefix(startedAt);
    const job = await this.backupJobModel.create({
      mode: options.mode,
      status: BackupStatus.RUNNING,
      trigger: options.trigger,
      bucket,
      objectPrefix,
      manifest: {},
      startedAt,
    });

    try {
      await this.minioService.ensureBucket(bucket);
      const includeAttachments = options.includeAttachments ?? options.mode === BackupMode.FULL_SYSTEM;
      const artifacts: BackupArtifact[] = [];

      // Gestreamt (H-36): Cursor -> JSON -> async gzip -> MinIO-Multipart.
      // Vorher lag die ganze DB viermal im Speicher (toArray, Objekt, String,
      // Buffer) und `gzipSync` blockierte den Event Loop für die gesamte
      // Kompression — Terminals, MCP und Healthchecks standen still.
      artifacts.push(await this.writeStreamArtifact(
        bucket, `${objectPrefix}/mongodb.json.gz`, this.exportDatabaseStream(), 'application/gzip',
      ));

      if (includeAttachments) {
        const attachmentManifest = await this.snapshotAttachments(bucket, objectPrefix);
        artifacts.push(await this.writeStreamArtifact(
          bucket,
          `${objectPrefix}/attachments-manifest.json.gz`,
          Readable.from([JSON.stringify(attachmentManifest, null, 2)]),
          'application/gzip',
        ));
      }

      const manifest = this.buildManifest({
        jobId: job._id.toString(),
        startedAt,
        finishedAt: new Date(),
        mode: options.mode,
        trigger: options.trigger,
        bucket,
        objectPrefix,
        includeAttachments,
        artifacts,
      });
      const manifestPayload = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
      artifacts.push(await this.writeArtifact(bucket, `${objectPrefix}/manifest.json`, manifestPayload, 'application/json'));
      await this.writeLatestPointer(bucket, objectPrefix, manifest);

      const completed = await this.backupJobModel.findByIdAndUpdate(job._id, {
        status: BackupStatus.COMPLETED,
        manifest: { ...manifest, artifacts },
        finishedAt: new Date(),
      }, { new: true }).exec();
      // Der frühere `as Promise<BackupJobDocument>` behauptete, dass hier nie
      // null steht. Wenn der Job zwischendurch gelöscht wurde, wäre der
      // Aufrufer auf einem null gelandet, das der Typ ausschloss.
      if (!completed) throw new NotFoundException(`Backup job ${job._id.toString()} disappeared while running`);
      return completed;
    } catch (err) {
      const message = errorMessage(err);
      await this.backupJobModel.findByIdAndUpdate(job._id, {
        status: BackupStatus.FAILED,
        error: message,
        finishedAt: new Date(),
      }).exec();
      const jobId = (job._id as { toString(): string }).toString();
      void this.notificationsService
        .create(
          '⚠ Backup fehlgeschlagen',
          message.length > 200 ? message.slice(0, 200) + '…' : message,
          `/settings?tab=backups&jobId=${jobId}`,
          'backup_failed',
        )
        .catch(() => {
          this.logger.warn(`Failed to dispatch backup_failed notification for job ${jobId}`);
        });
      throw err;
    } finally {
      this.running = false;
    }
  }

  /**
   * Der Datenbank-Dump als JSON-Stream (unkomprimiert), ein Dokument nach dem
   * anderen aus dem Cursor statt der ganzen Collection per `toArray()`.
   *
   * Format v2: Dokumente als MongoDB Extended JSON (relaxed). v1 schrieb
   * `JSON.stringify(doc)` — ObjectId und Date wurden zu blossen Strings. Ein
   * Restore per `mongoimport` legte `_id`, `projectId` & Co. dann als Strings
   * an, und die Anwendung (die nach ObjectId sucht) fand nichts mehr: das
   * Backup sah vollständig aus und war nicht wiederherstellbar. EJSON
   * (`{"$oid": …}`, `{"$date": …}`) versteht mongoimport nativ.
   */
  exportDatabaseStream(): Readable {
    const maybeDb = this.connection.db;
    if (!maybeDb) throw new Error('MongoDB connection is not ready');
    const db = maybeDb;
    async function* documents(): AsyncGenerator<string> {
      yield `{"format":"devgrimoire.system-backup.database.v2","encoding":"mongodb-extended-json-relaxed","exportedAt":${JSON.stringify(new Date().toISOString())},"collections":{`;
      const collections = await db.listCollections().toArray();
      let firstCollection = true;
      for (const collectionInfo of collections) {
        const name = collectionInfo.name;
        if (name.startsWith('system.')) continue;
        if (EXCLUDED_BACKUP_COLLECTIONS.includes(name)) continue;
        yield `${firstCollection ? '' : ','}${JSON.stringify(name)}:[`;
        firstCollection = false;
        let firstDoc = true;
        for await (const doc of db.collection(name).find({})) {
          yield `${firstDoc ? '' : ','}${mongo.BSON.EJSON.stringify(doc, { relaxed: true })}`;
          firstDoc = false;
        }
        yield ']';
      }
      yield '}}';
    }
    // Zu ~64-KB-Chunks bündeln: ein Chunk pro Dokument schickte jedes
    // Dokument einzeln durch gzip und Upload — gemessen 43 s für 200.000
    // kleine Dokumente.
    async function* batched(): AsyncGenerator<string> {
      let buf = '';
      for await (const piece of documents()) {
        buf += piece;
        if (buf.length >= 65_536) {
          yield buf;
          buf = '';
        }
      }
      if (buf) yield buf;
    }
    return Readable.from(batched());
  }

  private async snapshotAttachments(bucket: string, objectPrefix: string): Promise<Record<string, unknown>> {
    const sourceBucket = process.env.MINIO_BUCKET || 'devgrimoire';
    const objectKeys = await this.minioService.listObjects(sourceBucket);
    const copied: Array<{ sourceKey: string; backupKey: string; size?: number; etag?: string }> = [];

    for (const sourceKey of objectKeys) {
      const backupKey = `${objectPrefix}/attachments/${sourceKey}`;
      await this.minioService.copyObject(sourceBucket, sourceKey, bucket, backupKey);
      const stat = await this.minioService.statObjectInBucket(bucket, backupKey).catch(() => undefined);
      copied.push({ sourceKey, backupKey, size: stat?.size, etag: stat?.etag });
    }

    return {
      format: 'devgrimoire.system-backup.attachments.v1',
      sourceBucket,
      count: copied.length,
      objects: copied,
    };
  }

  private buildManifest(input: {
    jobId: string;
    startedAt: Date;
    finishedAt: Date;
    mode: BackupMode;
    trigger: 'manual' | 'scheduled';
    bucket: string;
    objectPrefix: string;
    includeAttachments: boolean;
    artifacts: BackupArtifact[];
  }): Record<string, unknown> {
    return {
      format: 'devgrimoire.system-backup.v1',
      jobId: input.jobId,
      app: {
        name: 'DevGrimoire',
        version: process.env.npm_package_version || 'unknown',
        gitSha: process.env.GIT_SHA || null,
      },
      mode: input.mode,
      trigger: input.trigger,
      startedAt: input.startedAt.toISOString(),
      finishedAt: input.finishedAt.toISOString(),
      bucket: input.bucket,
      objectPrefix: input.objectPrefix,
      includes: {
        database: true,
        attachments: input.includeAttachments,
      },
      excludedCollections: EXCLUDED_BACKUP_COLLECTIONS,
      // Vorher stand hier `plaintextSecrets: false` — wahr nur für die
      // `secrets`-Collection, während Klartext-Refresh-Tokens und
      // Replikations-API-Keys im Dump lagen (H-37). Das Feld lud dazu ein,
      // das Artefakt als unkritisch zu behandeln. Jetzt: was drinsteckt, und
      // in welcher Form. Das Artefakt bleibt schutzbedürftig.
      credentialMaterial: {
        containsCredentialMaterial: true,
        items: CREDENTIAL_MATERIAL_ITEMS,
        restoreRequiresSameEncryptionKey: true,
      },
      restore: {
        note: 'Restore into a stopped or maintenance-mode instance. Verify checksums, restore MongoDB first, copy attachments, then reindex RAG content.',
      },
      artifacts: input.artifacts,
    };
  }

  /**
   * Komprimiert einen Stream asynchron und lädt ihn hoch; Größe und SHA-256
   * werden unterwegs gezählt, ohne das Artefakt je ganz zu puffern.
   */
  private async writeStreamArtifact(bucket: string, key: string, source: Readable, contentType: string): Promise<BackupArtifact> {
    const hash = createHash('sha256');
    let size = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    const out = new PassThrough();
    const upload = this.minioService.putStreamInBucket(bucket, key, out, contentType);
    // Beide Seiten gemeinsam abwarten: scheitert der Upload, soll der
    // Producer nicht ewig in einen vollen Puffer schreiben, und umgekehrt.
    await Promise.all([
      pipeline(source, createGzip(), tap, out).catch((err: unknown) => {
        out.destroy(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }),
      upload.catch((err: unknown) => {
        source.destroy();
        throw err;
      }),
    ]);
    return { key, size, sha256: hash.digest('hex'), contentType };
  }

  private async writeArtifact(bucket: string, key: string, buffer: Buffer, contentType: string): Promise<BackupArtifact> {
    await this.minioService.putObjectInBucket(bucket, key, buffer, contentType);
    return {
      key,
      size: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      contentType,
    };
  }

  private async writeLatestPointer(bucket: string, objectPrefix: string, manifest: Record<string, unknown>): Promise<void> {
    const payload = Buffer.from(JSON.stringify({ objectPrefix, manifestKey: `${objectPrefix}/manifest.json`, manifest }, null, 2), 'utf-8');
    await this.minioService.putObjectInBucket(bucket, 'backups/devgrimoire/latest.json', payload, 'application/json');
  }

  private getRetentionPolicy(): { keepLast: number; keepDays: number } {
    const keepLast = Number(process.env.BACKUP_RETENTION_KEEP_LAST || 14);
    const keepDays = Number(process.env.BACKUP_RETENTION_KEEP_DAYS || 30);
    return {
      keepLast: Number.isFinite(keepLast) && keepLast > 0 ? Math.floor(keepLast) : 14,
      keepDays: Number.isFinite(keepDays) && keepDays > 0 ? Math.floor(keepDays) : 30,
    };
  }

  private async getRetentionCandidates(keepLast: number, keepDays: number): Promise<RetentionCandidate[]> {
    const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000);
    const jobs = await this.backupJobModel.find({ status: BackupStatus.COMPLETED }).sort({ createdAt: -1 }).exec();
    return jobs
      .slice(keepLast)
      .filter((job) => {
        const createdAt = (job as BackupJobDocument & { createdAt?: Date }).createdAt;
        return createdAt && createdAt < cutoff;
      })
      .map((job) => {
        const createdAt = (job as BackupJobDocument & { createdAt?: Date }).createdAt;
        const artifacts = artifactsOf(job.manifest?.artifacts);
        const artifactKeys = artifacts.map((artifact) => artifact.key).filter(Boolean);
        if (job.objectPrefix && !artifactKeys.includes(`${job.objectPrefix}/manifest.json`)) {
          artifactKeys.push(`${job.objectPrefix}/manifest.json`);
        }
        return {
          jobId: job._id.toString(),
          createdAt,
          bucket: job.bucket,
          objectPrefix: job.objectPrefix,
          artifactKeys,
          status: job.status,
        };
      });
  }

  private buildRetentionReport(
    policy: { keepLast: number; keepDays: number },
    candidates: RetentionCandidate[],
    dryRun: boolean,
    note: string,
  ): Record<string, unknown> {
    return {
      dryRun,
      policy,
      deleteJobCount: candidates.length,
      deleteObjectCount: candidates.reduce((sum, candidate) => sum + candidate.artifactKeys.length, 0),
      candidates,
      note,
    };
  }

  private async verifyArtifact(bucket: string, artifact: BackupArtifact): Promise<Record<string, unknown>> {
    try {
      // Gestreamt hashen statt das ganze Artefakt zu puffern (H-36).
      const stream = await this.minioService.getObjectInBucket(bucket, artifact.key);
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        hash.update(buf);
        size += buf.length;
      }
      const sha256 = hash.digest('hex');
      const sizeMatches = size === artifact.size;
      const sha256Matches = sha256 === artifact.sha256;
      return {
        key: artifact.key,
        exists: true,
        size,
        expectedSize: artifact.size,
        sizeMatches,
        sha256Matches,
        contentType: artifact.contentType,
      };
    } catch (err) {
      return {
        key: artifact.key,
        exists: false,
        sizeMatches: false,
        sha256Matches: false,
        error: errorMessage(err),
      };
    }
  }

  /**
   * JSON aus einem Backup-Objekt. Liefert bewusst `unknown`: die Datei kommt aus
   * dem Objektspeicher und kann aus einer älteren Formatversion stammen oder
   * beschädigt sein. Vorher stand hier `JSON.parse(body) as T` — ein frei vom
   * Aufrufer gewählter Typ auf einem ungeprüften Wert.
   */
  private async readJsonObject(bucket: string, key: string): Promise<unknown> {
    const payload = await this.readObjectBuffer(bucket, key);
    const body = key.endsWith('.gz') ? gunzipSync(payload).toString('utf-8') : payload.toString('utf-8');
    return JSON.parse(body);
  }

  private async readObjectBuffer(bucket: string, key: string): Promise<Buffer> {
    const stream = await this.minioService.getObjectInBucket(bucket, key);
    return streamToBuffer(stream);
  }

  private getBackupBucket(): string {
    return process.env.BACKUP_MINIO_BUCKET || `${process.env.MINIO_BUCKET || 'devgrimoire'}-backups`;
  }

  private buildObjectPrefix(date: Date): string {
    const iso = date.toISOString();
    const [year, month, day] = iso.slice(0, 10).split('-');
    const stamp = iso.replace(/[:.]/g, '-');
    return `backups/devgrimoire/${year}/${month}/${day}/${stamp}`;
  }
}
