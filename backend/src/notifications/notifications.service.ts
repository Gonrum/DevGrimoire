import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { AppNotification, NotificationDocument } from './schemas/notification.schema';
import { PushService } from '../push/push.service';
import { SettingsService } from '../settings/settings.service';

export const NOTIFICATION_CREATED = 'notification.created';
export const NOTIFICATION_PUSH_CATEGORIES_KEY = 'notification_push_categories';
// Default: high-signal system events + notify_user/ask_user. All mcp_* disabled.
// Users can opt-in/out per category in NotificationsSettings.
export const DEFAULT_PUSH_CATEGORIES = [
  'notify_user',
  'ask_user',
  'workflow_failure',
  'monitoring_unhealthy',
  'replication_failed',
  'backup_failed',
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
      if (categories.includes(category)) {
        this.pushService.sendNotification(title, body, url).catch(() => {});
      }
    } else {
      this.pushService.sendNotification(title, body, url).catch(() => {});
    }
    return notification;
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
