import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { BackupJob, BackupJobDocument, BackupMode, BackupStatus } from './schemas/backup-job.schema';
import { CreateBackupDto } from './dto/create-backup.dto';
import { MinioService } from '../minio/minio.service';

interface BackupArtifact {
  key: string;
  size: number;
  sha256: string;
  contentType: string;
}

@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);
  private running = false;

  constructor(
    @InjectModel(BackupJob.name) private backupJobModel: Model<BackupJobDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly minioService: MinioService,
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
