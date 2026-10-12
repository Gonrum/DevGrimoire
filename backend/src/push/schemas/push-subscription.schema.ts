import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PushSubscriptionDocument = HydratedDocument<PushSubscriptionEntry>;

@Schema({ timestamps: true })
export class PushSubscriptionEntry {
  @Prop({ required: true, unique: true })
  endpoint: string;

  @Prop({ type: Object, required: true })
  keys: { p256dh: string; auth: string };

  /**
   * Besitzer des Abos (H-12). Vorher ohne Nutzerbezug: jeder Push ging an
   * jedes Abo der Instanz. Altbestand ohne userId bekommt nur Broadcasts
   * ohne Projektbezug, bis der Browser sich erneut meldet
   * (usePushNotifications tut das bei jedem Laden).
   */
  @Prop({ type: String, default: null, index: true })
  userId: string | null;

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const PushSubscriptionSchema = SchemaFactory.createForClass(PushSubscriptionEntry);
