import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { AppNotification, NotificationDocument } from './schemas/notification.schema';

export const NOTIFICATION_CREATED = 'notification.created';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(AppNotification.name)
    private notificationModel: Model<NotificationDocument>,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(title: string, body: string, url?: string): Promise<NotificationDocument> {
    const notification = await this.notificationModel.create({ title, body, url });
    this.eventEmitter.emit(NOTIFICATION_CREATED, {
      id: notification._id.toString(),
      title,
      body,
    });
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
}
