import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { errorMessage } from '../common/narrow';
import { Types } from 'mongoose';
import type { FilterQuery } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { AppNotification, NotificationDocument } from './schemas/notification.schema';
import { PushService } from '../push/push.service';
import { SettingsService } from '../settings/settings.service';
import { RequestContext } from '../common/request-context';
import type { ActorScope } from '../common/permissions';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { allowsPush, effectivePrefs, splitCsv, type NotificationPrefs } from './notification-prefs';

/** Empfänger und Projektbezug einer Notification (H-12). */
export interface NotificationTarget {
  /** Empfänger; ohne = Broadcast an alle Nutzer. */
  userId?: string | null;
  /** Projektbezug; dann nur für Actors mit Zugriff auf das Projekt sichtbar. */
  projectId?: string | null;
}

/** Was die API ausliefert: `read` pro Nutzer, ohne die Listen der anderen. */
export interface NotificationView {
  _id: unknown;
  title: string;
  body: string;
  url?: string;
  category?: string;
  read: boolean;
  userId: string | null;
  projectId: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type NotificationRow = AppNotification & { _id: unknown };

/**
 * Mongo-Filter für den Projekt-Scope eines Actors auf `projectId` (String).
 * Notifications ohne Projekt sind für alle sichtbar.
 */
function projectScopeFilter(actor: ActorScope): FilterQuery<AppNotification> | null {
  const mode = actor.projectScopeMode ?? 'all';
  if (mode === 'all') return null;
  if (mode === 'none') return { projectId: null };
  const allowed = (actor.allowedProjectIds ?? []).map(String);
  return { $or: [{ projectId: null }, { projectId: { $in: allowed } }] };
}

export const NOTIFICATION_CREATED = 'notification.created';
export const NOTIFICATION_PUSH_CATEGORIES_KEY = 'notification_push_categories';
// T-340: Quiet-Hours. When `enabled`, pushes inside [from, to) are suppressed
// UNLESS the category is in `overrides`. The notification doc is still created
// so the in-app bell renders it. Diese instanzweiten Keys sind heute der
// Default; die Einstellung pro Nutzer liegt am User (notification-prefs.ts).
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

/** So lange bleiben die Tool-Protokoll-Meldungen der MCP-Aufrufe liegen (M-48). */
export const MCP_NOTIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function expiresAtFor(category: string | undefined, from = new Date()): Date | undefined {
  return category?.startsWith('mcp_') ? new Date(from.getTime() + MCP_NOTIFICATION_TTL_MS) : undefined;
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectModel(AppNotification.name)
    private notificationModel: Model<NotificationDocument>,
    private eventEmitter: EventEmitter2,
    private pushService: PushService,
    private settingsService: SettingsService,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  /**
   * Altbestand der `mcp_*`-Meldungen bekommt nachträglich ein Ablaufdatum
   * (Erstellung + 7 Tage), damit der TTL-Index ihn abräumt (M-48). Idempotent.
   */
  async onModuleInit(): Promise<void> {
    try {
      const res = await this.notificationModel.updateMany(
        { category: { $regex: '^mcp_' }, expiresAt: { $exists: false } },
        [{ $set: { expiresAt: { $add: [{ $ifNull: ['$createdAt', '$$NOW'] }, MCP_NOTIFICATION_TTL_MS] } } }],
      ).exec();
      if (res.modifiedCount > 0) {
        this.logger.log(`${res.modifiedCount} MCP-Tool-Meldung(en) mit Ablaufdatum versehen`);
      }
    } catch (err) {
      this.logger.warn(`MCP-Meldungen nicht migriert: ${errorMessage(err)}`);
    }
  }

  async create(
    title: string,
    body: string,
    url?: string,
    category?: string,
    target: NotificationTarget = {},
  ): Promise<NotificationDocument> {
    const notification = await this.notificationModel.create({
      title, body, url, category,
      userId: target.userId ?? null,
      projectId: target.projectId ?? null,
      expiresAt: expiresAtFor(category),
    });
    this.eventEmitter.emit(NOTIFICATION_CREATED, {
      id: notification._id.toString(),
      title,
      body,
    });
    // Kategorie und Ruhezeit entscheidet die Einstellung des jeweiligen
    // Abo-Besitzers; ohne eigene gilt die instanzweite.
    const defaults = await this.instanceDefaults();
    const now = new Date();
    this.pushService
      .sendNotification(title, body, url, target, (stored) =>
        allowsPush(effectivePrefs(stored, defaults), category, now),
      )
      .catch(() => {});
    return notification;
  }

  /**
   * Instanzweite Einstellung (T-340) — Default für Nutzer ohne eigene und für
   * besitzerlose Abos. Ein Lesefehler fällt auf die eingebauten Defaults
   * zurück: lieber ein Push zu viel als ein verschluckter.
   */
  async instanceDefaults(): Promise<NotificationPrefs> {
    try {
      const [cats, enabled, from, to, overrides] = await Promise.all([
        this.settingsService.getOrDefault(NOTIFICATION_PUSH_CATEGORIES_KEY, DEFAULT_PUSH_CATEGORIES),
        this.settingsService.get(NOTIFICATION_QUIET_HOURS_ENABLED_KEY),
        this.settingsService.get(NOTIFICATION_QUIET_HOURS_FROM_KEY),
        this.settingsService.get(NOTIFICATION_QUIET_HOURS_TO_KEY),
        this.settingsService.getOrDefault(NOTIFICATION_QUIET_HOURS_OVERRIDES_KEY, DEFAULT_QUIET_HOURS_OVERRIDES),
      ]);
      return {
        pushCategories: splitCsv(cats),
        quietHours: { enabled: enabled === 'true', from: from ?? '22:00', to: to ?? '07:00', overrides: splitCsv(overrides) },
      };
    } catch {
      return {
        pushCategories: splitCsv(DEFAULT_PUSH_CATEGORIES),
        quietHours: { enabled: false, from: '22:00', to: '07:00', overrides: splitCsv(DEFAULT_QUIET_HOURS_OVERRIDES) },
      };
    }
  }

  /** Wirksame Einstellung des aktuellen Nutzers; `custom` = eigene gespeichert. */
  async getPreferences(): Promise<NotificationPrefs & { custom: boolean }> {
    const defaults = await this.instanceDefaults();
    const user = await this.prefsOwner();
    const stored = user?.notificationPrefs;
    return { ...effectivePrefs(stored, defaults), custom: !!stored };
  }

  /**
   * Speichert die eigene Einstellung. Ohne Nutzer-Datensatz (Auth
   * deaktiviert: Actor `system`) gibt es niemanden, an dem sie hängen könnte —
   * dann wird die instanzweite geschrieben, wie vorher.
   */
  async setPreferences(prefs: NotificationPrefs): Promise<NotificationPrefs & { custom: boolean }> {
    const actor = this.actor();
    const userId = actor?.userId;
    if (userId && Types.ObjectId.isValid(userId)) {
      const res = await this.userModel
        .updateOne({ _id: new Types.ObjectId(userId) }, { $set: { notificationPrefs: prefs } })
        .exec();
      if (res.matchedCount === 0) throw new NotFoundException('Nutzer nicht gefunden');
    } else {
      const q = prefs.quietHours;
      await Promise.all([
        this.settingsService.set(NOTIFICATION_PUSH_CATEGORIES_KEY, prefs.pushCategories.join(',')),
        this.settingsService.set(NOTIFICATION_QUIET_HOURS_ENABLED_KEY, q.enabled ? 'true' : 'false'),
        this.settingsService.set(NOTIFICATION_QUIET_HOURS_FROM_KEY, q.from),
        this.settingsService.set(NOTIFICATION_QUIET_HOURS_TO_KEY, q.to),
        this.settingsService.set(NOTIFICATION_QUIET_HOURS_OVERRIDES_KEY, q.overrides.join(',')),
      ]);
    }
    return this.getPreferences();
  }

  private async prefsOwner(): Promise<{ notificationPrefs?: unknown } | null> {
    const userId = this.actor()?.userId;
    if (!userId || !Types.ObjectId.isValid(userId)) return null;
    return this.userModel
      .findById(userId, { notificationPrefs: 1 })
      .lean<{ notificationPrefs?: unknown }>()
      .exec();
  }

  // ---------------------------------------------------------------------------
  // Lesen und Verwalten — pro Nutzer (H-12)
  //
  // Vorher gab es keinen Nutzerbezug: `DELETE /notifications/all` löschte
  // `deleteMany({})` — jede Notification jedes Nutzers —, `PUT /read-all`
  // setzte den einen globalen Lesestatus. Jetzt sieht und verändert ein Actor
  // nur seine Sicht: eigene + Broadcasts, gefiltert nach Projekt-Scope;
  // Lesen und Löschen von Broadcasts wird pro Nutzer vermerkt.
  //
  // Ohne Actor (Auth deaktiviert) bleibt das alte, globale Verhalten.
  // ---------------------------------------------------------------------------

  private actor(): (ActorScope & { userId: string }) | undefined {
    return RequestContext.getUser();
  }

  private visibleFilter(actor: ActorScope & { userId: string }): FilterQuery<AppNotification> {
    const parts: FilterQuery<AppNotification>[] = [
      { $or: [{ userId: null }, { userId: actor.userId }] },
      { dismissedBy: { $ne: actor.userId } },
    ];
    const scope = projectScopeFilter(actor);
    if (scope) parts.push(scope);
    return { $and: parts };
  }

  private unreadFilter(userId: string): FilterQuery<AppNotification> {
    return { read: { $ne: true }, readBy: { $ne: userId } };
  }

  private toView(row: NotificationRow, userId: string | undefined): NotificationView {
    return {
      _id: row._id,
      title: row.title,
      body: row.body,
      url: row.url,
      category: row.category,
      read: row.read === true || (!!userId && (row.readBy ?? []).includes(userId)),
      userId: row.userId ?? null,
      projectId: row.projectId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Lädt eine sichtbare Notification oder wirft 404 (auch für fremde). */
  private async findVisible(id: string, actor: ActorScope & { userId: string }): Promise<NotificationRow> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException(`Notification ${id} not found`);
    const row = await this.notificationModel
      .findOne({ $and: [{ _id: id }, this.visibleFilter(actor)] })
      .lean<NotificationRow>()
      .exec();
    if (!row) throw new NotFoundException(`Notification ${id} not found`);
    return row;
  }

  async findAll(limit = 30, unreadOnly = false): Promise<NotificationView[]> {
    const actor = this.actor();
    const parts: FilterQuery<AppNotification>[] = [];
    if (actor) parts.push(this.visibleFilter(actor));
    if (unreadOnly) parts.push(actor ? this.unreadFilter(actor.userId) : { read: false });
    const rows = await this.notificationModel
      .find(parts.length ? { $and: parts } : {})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<NotificationRow[]>()
      .exec();
    return rows.map((row) => this.toView(row, actor?.userId));
  }

  async unreadCount(): Promise<number> {
    const actor = this.actor();
    if (!actor) return this.notificationModel.countDocuments({ read: false }).exec();
    return this.notificationModel
      .countDocuments({ $and: [this.visibleFilter(actor), this.unreadFilter(actor.userId)] })
      .exec();
  }

  async markAsRead(id: string): Promise<NotificationView> {
    const actor = this.actor();
    if (!actor) {
      const notification = await this.notificationModel
        .findByIdAndUpdate(id, { read: true }, { new: true })
        .lean<NotificationRow>()
        .exec();
      if (!notification) throw new NotFoundException(`Notification ${id} not found`);
      return this.toView(notification, undefined);
    }
    const row = await this.findVisible(id, actor);
    await this.notificationModel.updateOne({ _id: id }, { $addToSet: { readBy: actor.userId } }).exec();
    return this.toView({ ...row, readBy: [...(row.readBy ?? []), actor.userId] }, actor.userId);
  }

  async markAllAsRead(): Promise<void> {
    const actor = this.actor();
    if (!actor) {
      await this.notificationModel.updateMany({ read: false }, { read: true }).exec();
      return;
    }
    await this.notificationModel
      .updateMany(
        { $and: [this.visibleFilter(actor), this.unreadFilter(actor.userId)] },
        { $addToSet: { readBy: actor.userId } },
      )
      .exec();
  }

  /**
   * Eigene Notifications werden gelöscht, Broadcasts nur für diesen Nutzer
   * ausgeblendet — sonst verschwänden sie für alle.
   */
  async delete(id: string): Promise<void> {
    const actor = this.actor();
    if (!actor) {
      const result = await this.notificationModel.findByIdAndDelete(id).exec();
      if (!result) throw new NotFoundException(`Notification ${id} not found`);
      return;
    }
    const row = await this.findVisible(id, actor);
    if (row.userId === actor.userId) {
      await this.notificationModel.deleteOne({ _id: id }).exec();
    } else {
      await this.notificationModel.updateOne({ _id: id }, { $addToSet: { dismissedBy: actor.userId } }).exec();
    }
  }

  async deleteAll(): Promise<{ deleted: number }> {
    const actor = this.actor();
    if (!actor) {
      const result = await this.notificationModel.deleteMany({}).exec();
      return { deleted: result.deletedCount };
    }
    const visible = this.visibleFilter(actor);
    const own = await this.notificationModel
      .deleteMany({ $and: [visible, { userId: actor.userId }] })
      .exec();
    const dismissed = await this.notificationModel
      .updateMany({ $and: [visible, { userId: null }] }, { $addToSet: { dismissedBy: actor.userId } })
      .exec();
    return { deleted: own.deletedCount + dismissed.modifiedCount };
  }
}
