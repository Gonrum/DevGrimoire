import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { WorkflowScope } from './workflow-definition.schema';

export type WorkflowRunDocument = WorkflowRun & Document;

export enum WorkflowRunStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  WAITING_FOR_USER = 'waiting_for_user',
  WAITING_FOR_TIMER = 'waiting_for_timer',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Schema({ timestamps: true })
export class WorkflowRun {
  @Prop({ type: Types.ObjectId, ref: 'WorkflowDefinition', required: true, index: true })
  definitionId: Types.ObjectId;

  @Prop({ required: true, min: 1 })
  definitionVersion: number;

  @Prop({ type: Object, required: true })
  definitionSnapshot: Record<string, unknown>;

  @Prop({ required: true, enum: WorkflowScope, index: true })
  scope: WorkflowScope;

  @Prop({ type: Types.ObjectId, ref: 'Project', index: true })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer', index: true })
  customerId?: Types.ObjectId;

  @Prop({ type: Object, required: true })
  trigger: Record<string, unknown>;

  @Prop({ enum: WorkflowRunStatus, default: WorkflowRunStatus.QUEUED, index: true })
  status: WorkflowRunStatus;

  @Prop({ type: [String], default: [] })
  currentNodeIds: string[];

  @Prop()
  startedAt?: Date;

  @Prop()
  finishedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdByUserId?: Types.ObjectId;

  @Prop({ type: Object })
  error?: Record<string, unknown>;

  @Prop({ type: Object, default: () => ({ nodes: {} }) })
  context: Record<string, unknown>;

  @Prop({ type: Object })
  triggeredBy?: {
    type: 'manual' | 'schedule' | 'event';
    scheduleSlotAt?: Date;
    userId?: string;
  };

  createdAt?: Date;
  updatedAt?: Date;
}

export const WorkflowRunSchema = SchemaFactory.createForClass(WorkflowRun);

WorkflowRunSchema.index({ definitionId: 1, createdAt: -1 });
WorkflowRunSchema.index({ scope: 1, projectId: 1, customerId: 1, status: 1, createdAt: -1 });
WorkflowRunSchema.index({ status: 1, updatedAt: 1 });
WorkflowRunSchema.index(
  { definitionId: 1, 'triggeredBy.scheduleSlotAt': 1 },
  { unique: true, sparse: true, name: 'uniq_run_per_schedule_slot' },
);
