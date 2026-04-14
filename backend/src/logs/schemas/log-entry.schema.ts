import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type LogEntryDocument = HydratedDocument<LogEntry>;

@Schema({ timestamps: true })
export class LogEntry {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  @Prop({ type: String, enum: ['debug', 'info', 'warn', 'error'], default: 'info' })
  level: string;

  @Prop({ required: true })
  message: string;

  @Prop()
  service?: string;

  @Prop()
  area?: string;

  @Prop({ type: String, enum: ['production', 'staging', 'development', 'test'] })
  environment?: string;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop()
  source?: string;

  @Prop({ required: true })
  expiresAt: Date;
}

export const LogEntrySchema = SchemaFactory.createForClass(LogEntry);
LogEntrySchema.index({ projectId: 1, level: 1, createdAt: -1 });
LogEntrySchema.index({ projectId: 1, service: 1 });
LogEntrySchema.index({ projectId: 1, tags: 1 });
LogEntrySchema.index({ message: 'text', service: 'text', area: 'text' });
LogEntrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
