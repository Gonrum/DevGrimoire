import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BackupJobDocument = HydratedDocument<BackupJob>;

export enum BackupMode {
  DATABASE = 'database',
  FULL_SYSTEM = 'full-system',
}

export enum BackupStatus {
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Schema({ timestamps: true })
export class BackupJob {
  @Prop({ enum: BackupMode, default: BackupMode.FULL_SYSTEM })
  mode: BackupMode;

  @Prop({ enum: BackupStatus, default: BackupStatus.RUNNING })
  status: BackupStatus;

  @Prop({ default: 'manual' })
  trigger: 'manual' | 'scheduled';

  @Prop()
  bucket: string;

  @Prop()
  objectPrefix: string;

  @Prop({ type: Object })
  manifest: Record<string, unknown>;

  @Prop()
  error: string;

  @Prop()
  startedAt: Date;

  @Prop()
  finishedAt: Date;
}

export const BackupJobSchema = SchemaFactory.createForClass(BackupJob);
BackupJobSchema.index({ createdAt: -1 });
BackupJobSchema.index({ status: 1, createdAt: -1 });
