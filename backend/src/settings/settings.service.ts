import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Setting, SettingDocument } from './schemas/setting.schema';
import { EncryptionService } from '../common/encryption.service';
import { errorMessage } from '../common/narrow';

/**
 * Settings, die at rest verschlüsselt liegen (H-37 / C-7).
 *
 * Die Replikations-API-Keys erlauben `POST /api/replication/receive` auf der
 * Gegeninstanz, also Schreiben und Löschen in jedem freigeschalteten Projekt.
 * Sie lagen bisher roh in `settings` — und damit im Klartext in jedem
 * Backup-Artefakt und jedem `mongodump`.
 *
 * Die Strings stehen hier statt als Import aus `replication.constants`, damit
 * das Settings-Modul nicht vom Replikations-Modul abhängt.
 */
export const ENCRYPTED_SETTING_KEYS: ReadonlySet<string> = new Set([
  'replication.slave.apiKey',
  'replication.peer.apiKey',
]);

/** Format von EncryptionService.encrypt(): iv:authTag:ciphertext, alles hex. */
const ENCRYPTED_FORMAT = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]*$/;

export function isEncryptedSettingKey(key: string): boolean {
  return ENCRYPTED_SETTING_KEYS.has(key);
}

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @InjectModel(Setting.name)
    private settingModel: Model<SettingDocument>,
    // Optional, damit Check-Skripte den Service weiter mit nur dem Modell
    // konstruieren können; dann verhält er sich wie vorher (kein Krypto).
    @Optional() private readonly encryption?: EncryptionService,
  ) {}

  /**
   * Einmalige Migration beim Start: Klartext-Werte sensibler Keys
   * verschlüsseln. Idempotent — bereits verschlüsselte Werte erkennt das
   * Format. Ohne SECRETS_ENCRYPTION_KEY bleibt alles wie es ist (laut
   * gewarnt), damit eine Instanz ohne Key die Replikation nicht verliert.
   */
  async onModuleInit(): Promise<void> {
    if (!this.encryption) return;
    for (const key of ENCRYPTED_SETTING_KEYS) {
      try {
        const setting = await this.settingModel.findOne({ key }).exec();
        const raw = setting?.value;
        if (!raw || ENCRYPTED_FORMAT.test(raw)) continue;
        if (!this.encryption.isEnabled()) {
          this.logger.warn(`Setting "${key}" liegt im Klartext: SECRETS_ENCRYPTION_KEY ist nicht gesetzt`);
          continue;
        }
        await this.settingModel.updateOne({ key }, { value: this.encryption.encrypt(raw) }).exec();
        this.logger.log(`Setting "${key}" verschlüsselt (Migration H-37)`);
      } catch (err: unknown) {
        this.logger.error(`Migration von "${key}" fehlgeschlagen: ${errorMessage(err)}`);
      }
    }
  }

  async get(key: string): Promise<string | null> {
    const setting = await this.settingModel.findOne({ key }).exec();
    const value = setting?.value ?? null;
    if (value && isEncryptedSettingKey(key) && ENCRYPTED_FORMAT.test(value)) {
      return this.decrypt(key, value);
    }
    return value;
  }

  async getOrDefault(key: string, defaultValue: string): Promise<string> {
    const existing = await this.get(key);
    if (existing !== null) return existing;
    await this.set(key, defaultValue);
    return defaultValue;
  }

  async set(key: string, value: string): Promise<SettingDocument> {
    const stored = isEncryptedSettingKey(key) && value && this.encryption?.isEnabled()
      ? this.encryption.encrypt(value)
      : value;
    return this.settingModel.findOneAndUpdate(
      { key },
      { value: stored },
      { new: true, upsert: true },
    ).exec();
  }

  /**
   * Ein nicht entschlüsselbarer Wert (anderer Key, manipuliert) wird zu
   * `null` statt zum Chiffrat: das Chiffrat als API-Key an den Peer zu
   * schicken, sähe dort wie ein falscher Key aus und verschleierte die
   * Ursache. Ein fehlender Key verhält sich für den Aufrufer wie „nicht
   * konfiguriert", und das Log nennt den Grund.
   */
  private decrypt(key: string, value: string): string | null {
    if (!this.encryption?.isEnabled()) {
      this.logger.error(`Setting "${key}" ist verschlüsselt, aber SECRETS_ENCRYPTION_KEY fehlt`);
      return null;
    }
    try {
      return this.encryption.decrypt(value);
    } catch (err: unknown) {
      this.logger.error(`Setting "${key}" nicht entschlüsselbar: ${errorMessage(err)}`);
      return null;
    }
  }
}
