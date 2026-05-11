import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ValidationReportDocument = ValidationReport & Document;

export enum ValidationReportStatus {
  PASSED = 'passed',
  FAILED = 'failed',
  ERROR = 'error',
  SKIPPED = 'skipped',
}

@Schema({ timestamps: true, collection: 'validationreports' })
export class ValidationReport {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Todo', index: true })
  todoId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Commit', index: true })
  commitId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'WorkflowRun', index: true })
  workflowRunId?: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 120 })
  name: string;

  @Prop({ trim: true, maxlength: 500 })
  command?: string;

  @Prop({ required: true, enum: ValidationReportStatus, index: true })
  status: ValidationReportStatus;

  @Prop({ min: 0 })
  exitCode?: number;

  @Prop({ min: 0 })
  durationMs?: number;

  @Prop({ default: false })
  truncated: boolean;

  @Prop({ trim: true, maxlength: 8000 })
  summary?: string;

  @Prop({ trim: true, maxlength: 16000 })
  outputSnippet?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ValidationReportSchema = SchemaFactory.createForClass(ValidationReport);

ValidationReportSchema.index({ projectId: 1, createdAt: -1 });
ValidationReportSchema.index({ todoId: 1, createdAt: -1 });
ValidationReportSchema.index({ status: 1, createdAt: -1 });
