import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as webpush from 'web-push';
import { PushSubscriptionEntry, PushSubscriptionDocument } from './schemas/push-subscription.schema';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;
const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);

if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT!, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @InjectModel(PushSubscriptionEntry.name) private subModel: Model<PushSubscriptionDocument>,
  ) {}

  getPublicKey(): string {
    return VAPID_PUBLIC_KEY || '';
  }

  async subscribe(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<void> {
    await this.subModel.updateOne(
      { endpoint: subscription.endpoint },
      { $set: subscription },
      { upsert: true },
    ).exec();
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.subModel.deleteOne({ endpoint }).exec();
  }

  async sendNotification(title: string, body: string, url?: string): Promise<{ sent: number; failed: number }> {
    if (!PUSH_ENABLED) {
      this.logger.warn('Push notifications disabled: VAPID keys not configured');
      return { sent: 0, failed: 0 };
    }
    const subs = await this.subModel.find().lean().exec();
    const payload = JSON.stringify({ title, body, url });

    let sent = 0;
    let failed = 0;

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          payload,
        );
        sent++;
      } catch (err: any) {
        failed++;
        if (err.statusCode === 404 || err.statusCode === 410) {
          await this.subModel.deleteOne({ endpoint: sub.endpoint }).exec();
          this.logger.log(`Removed expired subscription: ${sub.endpoint.substring(0, 50)}...`);
        } else {
          this.logger.error(`Push failed: ${err.message}`);
        }
      }
    }

    return { sent, failed };
  }
}
