import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PushSubscriptionDocument = HydratedDocument<PushSubscriptionEntry>;

@Schema({ timestamps: true })
export class PushSubscriptionEntry {
  @Prop({ required: true, unique: true })
  endpoint: string;

  @Prop({ type: Object, required: true })
  keys: { p256dh: string; auth: string };

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const PushSubscriptionSchema = SchemaFactory.createForClass(PushSubscriptionEntry);
