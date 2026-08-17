import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { errorMessage } from '../common/narrow';
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

  // Bewusst synchron: die Erreichbarkeitsprüfung läuft absichtlich im
  // Hintergrund (siehe `void this.connect(...)` unten), es gibt hier also
  // nichts zu awaiten. `OnModuleInit` erlaubt `void` genauso wie `Promise<void>`.
  onModuleInit(): void {
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

    // Creating the client performs no network I/O — only the bucket check
    // below does. Run that check in the background so a configured-but-
    // unreachable MinIO never blocks Nest bootstrap: otherwise app.listen()
    // (and thus the Docker healthcheck) waits out the full TCP connect
    // timeout (~2 min) and the container is marked unhealthy on every boot.
    const client = new Minio.Client({
      endPoint: endpoint,
      port,
      useSSL,
      accessKey,
      secretKey,
    });
    const target = `${useSSL ? 'https' : 'http'}://${endpoint}:${port}`;
    void this.connect(client, target);
  }

  // Verify connectivity off the bootstrap path. `this.client` is only
  // exposed once the bucket check succeeds, so the operational methods keep
  // their "MinIO not available" contract while a reachable-but-slow or
  // unreachable endpoint resolves.
  private async connect(client: Minio.Client, target: string): Promise<void> {
    const CONNECT_TIMEOUT_MS = 10_000;
    try {
      const exists = await this.withTimeout(client.bucketExists(this.bucket), CONNECT_TIMEOUT_MS);
      if (!exists) {
        const region = process.env.MINIO_REGION || 'us-east-1';
        await this.withTimeout(client.makeBucket(this.bucket, region), CONNECT_TIMEOUT_MS);
        this.logger.log(`Bucket "${this.bucket}" created`);
      }

      this.client = client;
      this._enabled = true;
      this.logger.log(`MinIO connected → ${target}/${this.bucket}`);
    } catch (err) {
      this.logger.error(`MinIO initialization failed: ${errorMessage(err)} — file storage disabled`);
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref();
      }),
    ]);
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
