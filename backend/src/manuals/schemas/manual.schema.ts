import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ManualDocument = HydratedDocument<Manual>;

@Schema({ timestamps: true })
export class Manual {
  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ default: '' })
  content: string;

  @Prop()
  category?: string;

  @Prop({ default: 0 })
  sortOrder: number;

  @Prop({ default: 'claude' })
  lastEditedBy: string;

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const ManualSchema = SchemaFactory.createForClass(Manual);
ManualSchema.index({ projectId: 1 });
ManualSchema.index({ customerId: 1 });
ManualSchema.index({ projectId: 1, category: 1, sortOrder: 1 });
ManualSchema.index({ customerId: 1, category: 1, sortOrder: 1 });
ManualSchema.index({ title: 'text', content: 'text' });
