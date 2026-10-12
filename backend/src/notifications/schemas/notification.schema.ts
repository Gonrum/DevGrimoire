import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type NotificationDocument = HydratedDocument<AppNotification>;

@Schema({ timestamps: true })
export class AppNotification {
  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  body: string;

  @Prop()
  url: string;

  /**
   * Legacy-Lesestatus aus der Zeit vor H-12, als es nur EINEN globalen
   * Status gab. Wird nicht mehr geschrieben; ein Altbestand mit `true` gilt
   * weiter für alle als gelesen.
   */
  @Prop({ default: false })
  read: boolean;

  @Prop()
  category: string;

  /**
   * Empfänger (H-12). `null`/fehlend = Broadcast an alle Nutzer
   * (System-Ereignisse wie Monitoring, Backups, Replikation). Gesetzt für
   * alles, was aus dem Kontext eines Nutzers entsteht (MCP-Tool-Aufrufe,
   * notify_user, Recherche-Läufe).
   */
  @Prop({ type: String, default: null, index: true })
  userId: string | null;

  /** Projektbezug; sichtbar nur für Actors mit Zugriff auf das Projekt. */
  @Prop({ type: String, default: null })
  projectId: string | null;

  /** Nutzer, die die Notification gelesen haben — Status pro Nutzer. */
  @Prop({ type: [String], default: [] })
  readBy: string[];

  /**
   * Nutzer, die eine BROADCAST-Notification für sich gelöscht haben. Ein
   * Broadcast wird nie physisch gelöscht, sonst verschwände er für alle —
   * genau das war `DELETE /api/notifications/all`.
   */
  @Prop({ type: [String], default: [] })
  dismissedBy: string[];

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(AppNotification);
NotificationSchema.index({ read: 1, createdAt: -1 });
