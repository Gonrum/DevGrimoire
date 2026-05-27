import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { AppNotification, NotificationDocument } from './schemas/notification.schema';
import { PushService } from '../push/push.service';
import { SettingsService } from '../settings/settings.service';

export const NOTIFICATION_CREATED = 'notification.created';
export const NOTIFICATION_PUSH_CATEGORIES_KEY = 'notification_push_categories';
// T-340: Quiet-Hours stored as instance-wide settings (matches the existing
// per-category opt-in pattern — per-user infra doesn't exist yet, single-user
// dev instance in practice). When `enabled`, pushes inside [from, to) are
// suppressed UNLESS the category is in `overrides`. The notification doc is
// still created so the in-app bell renders it.
export const NOTIFICATION_QUIET_HOURS_ENABLED_KEY = 'notification_quiet_hours_enabled';
export const NOTIFICATION_QUIET_HOURS_FROM_KEY = 'notification_quiet_hours_from';
export const NOTIFICATION_QUIET_HOURS_TO_KEY = 'notification_quiet_hours_to';
export const NOTIFICATION_QUIET_HOURS_OVERRIDES_KEY = 'notification_quiet_hours_overrides';
// Default: high-signal system events + notify_user/ask_user. All mcp_* disabled.
// Users can opt-in/out per category in NotificationsSettings.
export const DEFAULT_PUSH_CATEGORIES = [
  'notify_user',
  'ask_user',
  'workflow_failure',
  'monitoring_unhealthy',
  'replication_failed',
  'backup_failed',
  'ssh_auth_failure',
].join(',');
// Sensible quiet-hours override defaults — failures and explicit pings always come through.
export const DEFAULT_QUIET_HOURS_OVERRIDES = [
  'monitoring_unhealthy',
  'workflow_failure',
  'backup_failed',
  'replication_failed',
].join(',');

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(AppNotification.name)
    private notificationModel: Model<NotificationDocument>,
    private eventEmitter: EventEmitter2,
    private pushService: PushService,
    private settingsService: SettingsService,
  ) {}

  async create(title: string, body: string, url?: string, category?: string): Promise<NotificationDocument> {
    const notification = await this.notificationModel.create({ title, body, url, category });
    this.eventEmitter.emit(NOTIFICATION_CREATED, {
      id: notification._id.toString(),
      title,
      body,
    });
    // Check if push is enabled for this category
    if (category) {
      const enabled = await this.settingsService.getOrDefault(
        NOTIFICATION_PUSH_CATEGORIES_KEY,
        DEFAULT_PUSH_CATEGORIES,
      );
      const categories = enabled.split(',').map((c) => c.trim()).filter(Boolean);
      if (categories.includes(category) && !(await this.isPushSuppressedByQuietHours(category))) {
        this.pushService.sendNotification(title, body, url).catch(() => {});
      }
    } else if (!(await this.isPushSuppressedByQuietHours(undefined))) {
      this.pushService.sendNotification(title, body, url).catch(() => {});
    }
    return notification;
  }

  /**
   * T-340: returns true when the current server time falls inside the
   * configured quiet-hours window AND the category is not on the override
   * allowlist. Categories without an explicit category param are treated as
   * non-override (still suppressed during quiet hours).
   *
   * Failure mode is fail-open: any parse error or missing setting → return
   * false (notification gets pushed). Silently swallowing pushes is worse
   * than letting one slip through during configuration mishaps.
   */
  private async isPushSuppressedByQuietHours(category: string | undefined): Promise<boolean> {
    try {
      const enabledStr = await this.settingsService.get(NOTIFICATION_QUIET_HOURS_ENABLED_KEY);
      if (enabledStr !== 'true') return false;
      const overrides = (
        await this.settingsService.getOrDefault(NOTIFICATION_QUIET_HOURS_OVERRIDES_KEY, DEFAULT_QUIET_HOURS_OVERRIDES)
      )
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      if (category && overrides.includes(category)) return false;

      const from = await this.settingsService.get(NOTIFICATION_QUIET_HOURS_FROM_KEY);
      const to = await this.settingsService.get(NOTIFICATION_QUIET_HOURS_TO_KEY);
      if (!from || !to) return false;
      const fromMin = this.parseHHMM(from);
      const toMin = this.parseHHMM(to);
      if (fromMin === null || toMin === null) return false;

      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      // Window wraps midnight when from > to (e.g. 22:00 → 07:00).
      return fromMin <= toMin
        ? nowMin >= fromMin && nowMin < toMin
        : nowMin >= fromMin || nowMin < toMin;
    } catch {
      return false;
    }
  }

  private parseHHMM(value: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
    return h * 60 + mm;
  }

  async findAll(limit = 30, unreadOnly = false): Promise<NotificationDocument[]> {
    const filter = unreadOnly ? { read: false } : {};
    return this.notificationModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  async unreadCount(): Promise<number> {
    return this.notificationModel.countDocuments({ read: false }).exec();
  }

  async markAsRead(id: string): Promise<NotificationDocument> {
    const notification = await this.notificationModel
      .findByIdAndUpdate(id, { read: true }, { new: true })
      .exec();
    if (!notification) throw new NotFoundException(`Notification ${id} not found`);
    return notification;
  }

  async markAllAsRead(): Promise<void> {
    await this.notificationModel.updateMany({ read: false }, { read: true }).exec();
  }

  async delete(id: string): Promise<void> {
    const result = await this.notificationModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Notification ${id} not found`);
  }

  async deleteAll(): Promise<{ deleted: number }> {
    const result = await this.notificationModel.deleteMany({}).exec();
    return { deleted: result.deletedCount };
  }
}
