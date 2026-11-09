import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type ActivityDocument = HydratedDocument<Activity>;

@Schema({ timestamps: true })
export class Activity {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  @Prop({ required: true })
  entity: string;

  @Prop({ required: true })
  action: string;

  @Prop({ type: SchemaTypes.ObjectId })
  entityId: Types.ObjectId;

  @Prop()
  summary: string;

  @Prop()
  userId: string;

  @Prop()
  username: string;

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const ActivitySchema = SchemaFactory.createForClass(Activity);
ActivitySchema.index({ projectId: 1, createdAt: -1 });
ActivitySchema.index({ customerId: 1, createdAt: -1 });
