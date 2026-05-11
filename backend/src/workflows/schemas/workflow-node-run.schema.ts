import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type WorkflowNodeRunDocument = WorkflowNodeRun & Document;

export enum WorkflowNodeRunStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  WAITING = 'waiting',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  SKIPPED = 'skipped',
  RETRYING = 'retrying',
  INTERRUPTED = 'interrupted',
}

@Schema({ timestamps: true })
export class WorkflowNodeRun {
  @Prop({ type: Types.ObjectId, ref: 'WorkflowRun', required: true, index: true })
  runId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'WorkflowDefinition', required: true, index: true })
  definitionId: Types.ObjectId;

  @Prop({ required: true, min: 1 })
  definitionVersion: number;

  @Prop({ required: true })
  nodeId: string;

  @Prop({ required: true, index: true })
  nodeType: string;

  @Prop({ enum: WorkflowNodeRunStatus, default: WorkflowNodeRunStatus.QUEUED, index: true })
  status: WorkflowNodeRunStatus;

  @Prop({ default: 1, min: 1 })
  attempt: number;

  @Prop({ type: Object })
  inputSnapshot?: Record<string, unknown>;

  @Prop({ type: Object })
  outputSnapshot?: Record<string, unknown>;

  @Prop({ type: [Object], default: [] })
  logs: Record<string, unknown>[];

  @Prop({ type: Object })
  error?: Record<string, unknown>;

  @Prop()
  startedAt?: Date;

  @Prop()
  finishedAt?: Date;

  @Prop({ type: Object })
  waitingFor?: { type: 'question'; refId: Types.ObjectId };

  @Prop()
  durationMs?: number;
}

export const WorkflowNodeRunSchema = SchemaFactory.createForClass(WorkflowNodeRun);

WorkflowNodeRunSchema.index({ runId: 1, nodeId: 1, attempt: 1 });
WorkflowNodeRunSchema.index({ definitionId: 1, nodeType: 1, createdAt: -1 });
WorkflowNodeRunSchema.index({ status: 1, updatedAt: 1 });
