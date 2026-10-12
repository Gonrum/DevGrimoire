import { Injectable, Logger } from '@nestjs/common';
import { errorMessage, isRecord } from '../common/narrow';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as webpush from 'web-push';
import { PushSubscriptionEntry, PushSubscriptionDocument } from './schemas/push-subscription.schema';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { actorFromUser } from '../common/actor-scope';
import { actorCanAccessProject } from '../common/permissions';

/** Empfänger/Projekt einer Push-Nachricht — dieselbe Form wie NotificationTarget. */
export interface PushTarget {
  userId?: string | null;
  projectId?: string | null;
}

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;
const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);

if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @InjectModel(PushSubscriptionEntry.name) private subModel: Model<PushSubscriptionDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  getPublicKey(): string {
    return VAPID_PUBLIC_KEY || '';
  }

  /**
   * `userId` kommt aus der Authentifizierung, nicht aus dem Body. Ein
   * erneutes Melden desselben Endpoints zieht das Abo auf den aktuellen
   * Nutzer um (geteiltes Gerät, Account-Wechsel).
   */
  async subscribe(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    userId: string | null,
  ): Promise<void> {
    await this.subModel.updateOne(
      { endpoint: subscription.endpoint },
      { $set: { endpoint: subscription.endpoint, keys: subscription.keys, userId } },
      { upsert: true },
    ).exec();
  }

  /**
   * Nur das eigene Abo (oder ein besitzerloses aus der Zeit vor H-12). Ohne
   * Nutzer (Auth deaktiviert) wie bisher.
   */
  async unsubscribe(endpoint: string, userId: string | null): Promise<void> {
    const filter = userId
      ? { endpoint, $or: [{ userId }, { userId: null }] }
      : { endpoint };
    await this.subModel.deleteOne(filter).exec();
  }

  /**
   * Welche Abos dürfen diese Nachricht bekommen? (H-12)
   * - mit Empfänger: nur dessen Abos
   * - mit Projekt: nur Besitzer mit Zugriff auf das Projekt (aktive Nutzer)
   * - Abos ohne Besitzer (Altbestand): nur reine Broadcasts ohne Projekt
   */
  private async recipients(target: PushTarget) {
    const subs = await this.subModel
      .find(target.userId ? { userId: target.userId } : {})
      .lean()
      .exec();
    if (!target.projectId) return subs;
    const ownerIds = [...new Set(subs.map((s) => s.userId).filter((id): id is string => !!id))];
    const owners = await this.userModel.find({ _id: { $in: ownerIds } }).lean().exec();
    const allowed = new Set(
      owners
        .filter((u) => u.active && actorCanAccessProject(actorFromUser(u), String(target.projectId)))
        .map((u) => u._id.toString()),
    );
    return subs.filter((s) => !!s.userId && allowed.has(s.userId));
  }

  async sendNotification(
    title: string,
    body: string,
    url?: string,
    target: PushTarget = {},
  ): Promise<{ sent: number; failed: number }> {
    if (!PUSH_ENABLED) {
      this.logger.warn('Push notifications disabled: VAPID keys not configured');
      return { sent: 0, failed: 0 };
    }
    const subs = await this.recipients(target);
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
      } catch (err: unknown) {
        failed++;
        // web-push wirft ein WebPushError mit statusCode; 404/410 heissen
        // „Endpoint existiert nicht mehr" und rechtfertigen das Löschen.
        const statusCode = isRecord(err) && typeof err.statusCode === 'number'
          ? err.statusCode
          : undefined;
        if (statusCode === 404 || statusCode === 410) {
          await this.subModel.deleteOne({ endpoint: sub.endpoint }).exec();
          this.logger.log(`Removed expired subscription: ${sub.endpoint.substring(0, 50)}...`);
        } else {
          this.logger.error(`Push failed: ${errorMessage(err)}`);
        }
      }
    }

    return { sent, failed };
  }
}
