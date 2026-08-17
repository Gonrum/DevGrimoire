import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type ReplicationQueueDocument = HydratedDocument<ReplicationQueue>;

@Schema({ timestamps: true })
export class ReplicationQueue {
  @Prop({ required: true })
  projectId: string;

  @Prop({ required: true })
  entity: string;

  @Prop({ required: true, enum: ['created', 'updated', 'deleted'] })
  action: string;

  @Prop({ required: true })
  entityId: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  document?: Record<string, unknown>;

  @Prop({ type: MongooseSchema.Types.Mixed })
  attachmentData?: {
    base64: string;
    fileName: string;
    mimeType: string;
    storageKey: string;
  };

  @Prop({ default: 0 })
  attempts: number;

  @Prop()
  lastAttempt?: Date;

  @Prop({ default: 'pending', enum: ['pending', 'failed', 'sent'] })
  status: string;

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const ReplicationQueueSchema = SchemaFactory.createForClass(ReplicationQueue);
ReplicationQueueSchema.index({ status: 1, createdAt: 1 });
