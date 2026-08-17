import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type NoteDocument = HydratedDocument<Note>;

export type PromotedEntityType =
  | 'knowledge'
  | 'snippet'
  | 'todo'
  | 'research'
  | 'manual';

@Schema({ _id: false })
export class PromotedRef {
  @Prop({ required: true, enum: ['knowledge', 'snippet', 'todo', 'research', 'manual'] })
  entityType: PromotedEntityType;

  @Prop({ type: Types.ObjectId, required: true })
  entityId: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  customerId?: Types.ObjectId;
}

export const PromotedRefSchema = SchemaFactory.createForClass(PromotedRef);

@Schema({ timestamps: true })
export class Note {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: String, default: '' })
  title: string;

  @Prop({ type: String, default: '' })
  content: string;

  @Prop({ type: Number, default: 0 })
  order: number;

  @Prop({ default: false })
  archived: boolean;

  @Prop({ type: Date })
  archivedAt?: Date;

  @Prop({ type: PromotedRefSchema })
  promotedTo?: PromotedRef;

  @Prop({ type: Date })
  idleSnoozeUntil?: Date;

  @Prop({ type: Number, default: 0 })
  promotionAttempts: number;

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — ohne Deklaration brauchten Leser dafür ein `as any`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const NoteSchema = SchemaFactory.createForClass(Note);

NoteSchema.index({ userId: 1, archived: 1, order: 1 });
NoteSchema.index({ userId: 1, archivedAt: -1 });
NoteSchema.index({ userId: 1, updatedAt: 1 });
