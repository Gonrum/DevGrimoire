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
    return encryptWithKey(this.key, plaintext);
  }

  decrypt(encryptedValue: string): string {
    if (!this.key) throw new Error('Encryption not configured: set SECRETS_ENCRYPTION_KEY');
    return decryptWithKey(this.key, encryptedValue);
  }
}

/**
 * Verschlüsseln mit einem ausdrücklich übergebenen Schlüssel. Der Service
 * nutzt das mit dem Schlüssel aus der Umgebung; die Re-Encryption (T-467)
 * braucht zwei Schlüssel gleichzeitig.
 *
 * Format: iv:authTag:ciphertext (alles hex).
 */
export function encryptWithKey(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptWithKey(key: Buffer, encryptedValue: string): string {
  const parts = encryptedValue.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted value format');

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = Buffer.from(parts[2], 'hex');

  // Längen explizit prüfen. `Buffer.from(..., 'hex')` verschluckt ungültige
  // Zeichen still und liefert einen zu kurzen Buffer — der Fehler käme sonst
  // erst als generisches "Unsupported state or unable to authenticate data"
  // aus `final()` und wäre von einem echten Manipulationsversuch nicht zu
  // unterscheiden. (AUTH_TAG_LENGTH war bis hierhin eine tote Konstante.)
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted value format');
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
