import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WorkspacesService } from './workspaces.service';
import { WorkspaceClient } from './workspace-client.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';

export const TTL_SETTING_ENABLED = 'workspace.ttl.enabled';
export const TTL_SETTING_ARCHIVE_DAYS = 'workspace.ttl.archive_after_days';
export const TTL_SETTING_DELETE_DAYS = 'workspace.ttl.delete_after_days';

const DEFAULT_ARCHIVE_DAYS = 14;
const DEFAULT_DELETE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SweepResult {
  archivedCount: number;
  deletedCount: number;
  skipped: boolean;
}

@Injectable()
export class WorkspaceTtlScheduler {
  private readonly logger = new Logger(WorkspaceTtlScheduler.name);

  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly workspaceClient: WorkspaceClient,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Runs daily at 03:30 UTC — distinct from the replication 03:00 sweep so
   * the two don't pile on Mongo at the same instant. Reads thresholds from
   * settings so an operator can tune them without redeploying.
   */
  @Cron('0 30 3 * * *')
  async nightlySweep(): Promise<SweepResult> {
    return this.sweep();
  }

  async sweep(): Promise<SweepResult> {
    const enabled = await this.readBool(TTL_SETTING_ENABLED, true);
    if (!enabled) {
      this.logger.log('TTL sweep skipped (workspace.ttl.enabled=false)');
      return { archivedCount: 0, deletedCount: 0, skipped: true };
    }

    const archiveDays = await this.readPositiveInt(TTL_SETTING_ARCHIVE_DAYS, DEFAULT_ARCHIVE_DAYS);
    const deleteDays = await this.readPositiveInt(TTL_SETTING_DELETE_DAYS, DEFAULT_DELETE_DAYS);

    const now = Date.now();
    const archiveBefore = new Date(now - archiveDays * DAY_MS);
    const deleteBefore = new Date(now - deleteDays * DAY_MS);

    let archivedCount = 0;
    let deletedCount = 0;

    // Phase 1 — archive stale active workspaces.
    const toArchive = await this.workspaces.findInactive('active', archiveBefore);
    for (const ws of toArchive) {
      try {
        await this.workspaces.archive(ws._id.toString());
        archivedCount += 1;
        await this.notifyArchived(ws.name, archiveDays).catch(() => undefined);
      } catch (err) {
        this.logger.warn(`archive failed for ${ws._id}: ${(err as Error).message}`);
      }
    }

    // Phase 2 — hard-delete archived workspaces that crossed the second
    // threshold. Sidecar /cleanup runs first so disk space is reclaimed
    // even when the DB delete fails afterwards.
    const toDelete = await this.workspaces.findInactive('archived', deleteBefore);
    for (const ws of toDelete) {
      try {
        if (this.workspaceClient.isConfigured()) {
          await this.workspaceClient.cleanup(ws._id.toString()).catch((err) => {
            this.logger.warn(`sidecar cleanup failed for ${ws._id}: ${(err as Error).message}`);
          });
        }
        await this.workspaces.remove(ws._id.toString());
        deletedCount += 1;
        await this.notifyDeleted(ws.name, deleteDays).catch(() => undefined);
      } catch (err) {
        this.logger.warn(`delete failed for ${ws._id}: ${(err as Error).message}`);
      }
    }

    if (archivedCount || deletedCount) {
      this.logger.log(`TTL sweep: archived=${archivedCount} deleted=${deletedCount}`);
    }
    return { archivedCount, deletedCount, skipped: false };
  }

  private async notifyArchived(name: string, days: number): Promise<void> {
    await this.notifications.create(
      'Workspace archiviert',
      `Workspace "${name}" wurde nach ${days} Tagen Inaktivität archiviert. Du kannst ihn reaktivieren oder löschen.`,
      undefined,
      'workspace_ttl',
    );
  }

  private async notifyDeleted(name: string, days: number): Promise<void> {
    await this.notifications.create(
      'Workspace gelöscht',
      `Workspace "${name}" war ${days} Tage archiviert und wurde jetzt unwiderruflich gelöscht (inkl. Disk).`,
      undefined,
      'workspace_ttl',
    );
  }

  private async readBool(key: string, fallback: boolean): Promise<boolean> {
    const raw = await this.settings.get(key);
    if (raw == null) return fallback;
    const v = raw.trim().toLowerCase();
    return !(v === 'false' || v === '0' || v === 'no' || v === '');
  }

  private async readPositiveInt(key: string, fallback: number): Promise<number> {
    const raw = await this.settings.get(key);
    if (raw == null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return fallback;
    return n;
  }
}
