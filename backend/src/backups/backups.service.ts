import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { createHash } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
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

interface BackupManifest {
  format?: string;
  jobId?: string;
  bucket?: string;
  objectPrefix?: string;
  artifacts?: BackupArtifact[];
  includes?: Record<string, unknown>;
  [key: string]: unknown;
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

@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);
  private running = false;

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
      this.logger.error(`Scheduled backup failed: ${(err as Error).message}`);
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
      throw new BadRequestException(`Retention cleanup requires confirm=\"${RETENTION_CONFIRMATION}\"`);
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
        errors.push({ jobId: candidate.jobId, message: (err as Error).message });
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
    const manifest = await this.readJsonObject<BackupManifest>(job.bucket, manifestKey);
    const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
    const checks = await Promise.all(artifacts.map(async (artifact) => this.verifyArtifact(job.bucket, artifact)));

    return {
      jobId: job._id.toString(),
      status: job.status,
      bucket: job.bucket,
      objectPrefix: job.objectPrefix,
      manifestKey,
      manifestFormat: manifest.format || null,
      includes: manifest.includes || {},
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

      const databasePayload = await this.exportDatabase();
      artifacts.push(await this.writeArtifact(bucket, `${objectPrefix}/mongodb.json.gz`, databasePayload, 'application/gzip'));

      if (includeAttachments) {
        const attachmentManifest = await this.snapshotAttachments(bucket, objectPrefix);
        const attachmentPayload = gzipSync(Buffer.from(JSON.stringify(attachmentManifest, null, 2), 'utf-8'));
        artifacts.push(await this.writeArtifact(bucket, `${objectPrefix}/attachments-manifest.json.gz`, attachmentPayload, 'application/gzip'));
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

      return this.backupJobModel.findByIdAndUpdate(job._id, {
        status: BackupStatus.COMPLETED,
        manifest: { ...manifest, artifacts },
        finishedAt: new Date(),
      }, { new: true }).exec() as Promise<BackupJobDocument>;
    } catch (err) {
      const message = (err as Error).message;
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

  private async exportDatabase(): Promise<Buffer> {
    const db = this.connection.db;
    if (!db) throw new Error('MongoDB connection is not ready');
    const collections = await db.listCollections().toArray();
    const dump: Record<string, unknown[]> = {};

    for (const collectionInfo of collections) {
      const name = collectionInfo.name;
      if (name.startsWith('system.')) continue;
      dump[name] = await db.collection(name).find({}).toArray();
    }

    const payload = {
      format: 'devgrimoire.system-backup.database.v1',
      exportedAt: new Date().toISOString(),
      collections: dump,
    };
    return gzipSync(Buffer.from(JSON.stringify(payload), 'utf-8'));
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
        plaintextSecrets: false,
      },
      restore: {
        note: 'Restore into a stopped or maintenance-mode instance. Verify checksums, restore MongoDB first, copy attachments, then reindex RAG content.',
      },
      artifacts: input.artifacts,
    };
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
        const artifacts = Array.isArray(job.manifest?.artifacts) ? job.manifest.artifacts as BackupArtifact[] : [];
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
      const payload = await this.readObjectBuffer(bucket, artifact.key);
      const sha256 = createHash('sha256').update(payload).digest('hex');
      const sizeMatches = payload.length === artifact.size;
      const sha256Matches = sha256 === artifact.sha256;
      return {
        key: artifact.key,
        exists: true,
        size: payload.length,
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
        error: (err as Error).message,
      };
    }
  }

  private async readJsonObject<T>(bucket: string, key: string): Promise<T> {
    const payload = await this.readObjectBuffer(bucket, key);
    const body = key.endsWith('.gz') ? gunzipSync(payload).toString('utf-8') : payload.toString('utf-8');
    return JSON.parse(body) as T;
  }

  private async readObjectBuffer(bucket: string, key: string): Promise<Buffer> {
    const stream = await this.minioService.getObjectInBucket(bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
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
