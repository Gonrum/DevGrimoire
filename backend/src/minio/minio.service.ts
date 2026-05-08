import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as Minio from 'minio';
import { Readable } from 'stream';

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private client: Minio.Client | null = null;
  private bucket: string;
  private _enabled = false;

  get enabled(): boolean {
    return this._enabled;
  }

  async onModuleInit(): Promise<void> {
    const endpoint = process.env.MINIO_ENDPOINT;
    if (!endpoint) {
      this.logger.warn('MINIO_ENDPOINT not set — file storage disabled');
      return;
    }

    const port = parseInt(process.env.MINIO_PORT || '9000', 10);
    const useSSL = process.env.MINIO_USE_SSL === 'true';
    const accessKey = process.env.MINIO_ACCESS_KEY || 'minioadmin';
    const secretKey = process.env.MINIO_SECRET_KEY || 'minioadmin';
    this.bucket = process.env.MINIO_BUCKET || 'devgrimoire';

    try {
      this.client = new Minio.Client({
        endPoint: endpoint,
        port,
        useSSL,
        accessKey,
        secretKey,
      });

      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        const region = process.env.MINIO_REGION || 'us-east-1';
        await this.client.makeBucket(this.bucket, region);
        this.logger.log(`Bucket "${this.bucket}" created`);
      }

      this._enabled = true;
      this.logger.log(`MinIO connected → ${useSSL ? 'https' : 'http'}://${endpoint}:${port}/${this.bucket}`);
    } catch (err) {
      this.logger.error(`MinIO initialization failed: ${(err as Error).message}`);
    }
  }

  isEnabled(): boolean {
    return this._enabled;
  }

  async putObject(key: string, buffer: Buffer, mimetype: string): Promise<void> {
    await this.putObjectInBucket(this.bucket, key, buffer, mimetype);
  }

  async putObjectInBucket(bucket: string, key: string, buffer: Buffer, mimetype: string): Promise<void> {
    if (!this.client) throw new Error('MinIO not available');
    await this.client.putObject(bucket, key, buffer, buffer.length, {
      'Content-Type': mimetype,
    });
  }

  async ensureBucket(bucket: string): Promise<void> {
    if (!this.client) throw new Error('MinIO not available');
    const exists = await this.client.bucketExists(bucket);
    if (!exists) {
      const region = process.env.MINIO_REGION || 'us-east-1';
      await this.client.makeBucket(bucket, region);
      this.logger.log(`Bucket "${bucket}" created`);
    }
  }

  async listObjects(bucket = this.bucket, prefix = ''): Promise<string[]> {
    if (!this.client) throw new Error('MinIO not available');
    const keys: string[] = [];
    const stream = this.client.listObjectsV2(bucket, prefix, true);
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (obj) => {
        if (obj.name) keys.push(obj.name);
      });
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    return keys;
  }

  async copyObject(sourceBucket: string, sourceKey: string, targetBucket: string, targetKey: string): Promise<void> {
    if (!this.client) throw new Error('MinIO not available');
    await this.client.copyObject(targetBucket, targetKey, `/${sourceBucket}/${sourceKey}`);
  }

  async statObjectInBucket(bucket: string, key: string): Promise<{ size: number; etag: string }> {
    if (!this.client) throw new Error('MinIO not available');
    const stat = await this.client.statObject(bucket, key);
    return { size: stat.size, etag: stat.etag };
  }

  async getObject(key: string): Promise<Readable> {
    if (!this.client) throw new Error('MinIO not available');
    return this.client.getObject(this.bucket, key);
  }

  async getObjectInBucket(bucket: string, key: string): Promise<Readable> {
    if (!this.client) throw new Error('MinIO not available');
    return this.client.getObject(bucket, key);
  }

  async removeObject(key: string): Promise<void> {
    if (!this.client) throw new Error('MinIO not available');
    await this.client.removeObject(this.bucket, key);
  }

  async removeObjects(keys: string[]): Promise<void> {
    if (!this.client || keys.length === 0) return;
    await this.client.removeObjects(this.bucket, keys);
  }

  async removeObjectsInBucket(bucket: string, keys: string[]): Promise<void> {
    if (!this.client || keys.length === 0) return;
    await this.client.removeObjects(bucket, keys);
  }

  async statObject(key: string): Promise<{ size: number; etag: string }> {
    if (!this.client) throw new Error('MinIO not available');
    const stat = await this.client.statObject(this.bucket, key);
    return { size: stat.size, etag: stat.etag };
  }
}
