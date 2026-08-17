import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum CustomerStatus {
  LEAD = 'lead',
  ONBOARDING = 'onboarding',
  ACTIVE = 'active',
  PAUSED = 'paused',
  OFFBOARDING = 'offboarding',
  CANCELLED = 'cancelled',
  ARCHIVED = 'archived',
}

export type CustomerDocument = HydratedDocument<Customer>;

@Schema({ timestamps: true })
export class Customer {
  @Prop({ required: true, unique: true, trim: true })
  name: string;

  @Prop()
  description?: string;

  @Prop({ type: String, enum: CustomerStatus, default: CustomerStatus.ACTIVE, index: true })
  status: CustomerStatus;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop()
  primaryContactName?: string;

  @Prop()
  primaryContactEmail?: string;

  @Prop()
  primaryContactPhone?: string;

  @Prop()
  website?: string;

  @Prop()
  notes?: string;

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const CustomerSchema = SchemaFactory.createForClass(Customer);
CustomerSchema.index({ status: 1, updatedAt: -1 });
CustomerSchema.index({ name: 'text', description: 'text', tags: 'text', notes: 'text' });
