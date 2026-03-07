import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer | null;

  constructor() {
    const keyHex = process.env.SECRETS_ENCRYPTION_KEY;
    if (keyHex && keyHex.length === 64) {
      this.key = Buffer.from(keyHex, 'hex');
      this.logger.log('Secrets encryption enabled');
    } else if (keyHex) {
      this.logger.error('SECRETS_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Secrets encryption disabled.');
      this.key = null;
    } else {
      this.logger.warn('SECRETS_ENCRYPTION_KEY not set. Secrets encryption disabled.');
      this.key = null;
    }
  }

  isEnabled(): boolean {
    return this.key !== null;
  }

  encrypt(plaintext: string): string {
    if (!this.key) throw new Error('Encryption not configured: set SECRETS_ENCRYPTION_KEY');

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:ciphertext (all hex)
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decrypt(encryptedValue: string): string {
    if (!this.key) throw new Error('Encryption not configured: set SECRETS_ENCRYPTION_KEY');

    const parts = encryptedValue.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted value format');

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}
