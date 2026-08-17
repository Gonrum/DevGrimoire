import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ContactDocument = HydratedDocument<Contact>;

@Schema({ timestamps: true })
export class Contact {
  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true, index: true })
  customerId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop()
  role?: string;

  @Prop()
  email?: string;

  @Prop()
  phone?: string;

  @Prop()
  notes?: string;

  @Prop({ default: false })
  isPrimary: boolean;

  @Prop({ default: 0 })
  sortOrder: number;

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const ContactSchema = SchemaFactory.createForClass(Contact);
ContactSchema.index({ customerId: 1, sortOrder: 1, _id: 1 });
ContactSchema.index({ customerId: 1, isPrimary: -1 });
