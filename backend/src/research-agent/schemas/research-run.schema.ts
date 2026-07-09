import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ResearchRunDocument = HydratedDocument<ResearchRun>;

export enum ResearchRunStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  DONE = 'done',
  ERROR = 'error',
  CANCELLED = 'cancelled',
}

/** One step of the background agent's tool-calling loop, recorded for audit/debugging. */
export interface RunStep {
  type: 'tool_call' | 'tool_result' | 'note';
  tool?: string;
  argsSummary?: string;
  resultSummary?: string;
  ts: Date;
}

export interface RunTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

@Schema({ timestamps: true })
export class ResearchRun {
  @Prop({ type: Types.ObjectId, ref: 'ResearchTopic', required: true })
  topicId: Types.ObjectId;

  @Prop()
  number: number;

  @Prop({ type: String, enum: ResearchRunStatus, default: ResearchRunStatus.QUEUED })
  status: ResearchRunStatus;

  @Prop({ type: String, enum: ['scheduled', 'manual'], required: true })
  trigger: 'scheduled' | 'manual';

  @Prop()
  startedAt?: Date;

  @Prop()
  finishedAt?: Date;

  @Prop({ type: [Object], default: [] })
  steps: RunStep[];

  @Prop({ type: [String], default: [] })
  artifactsCreated: string[];

  @Prop({ type: [String], default: [] })
  artifactsUpdated: string[];

  @Prop({ type: Object })
  tokenUsage?: RunTokenUsage;

  @Prop()
  summary?: string;

  @Prop()
  error?: string;
}

export const ResearchRunSchema = SchemaFactory.createForClass(ResearchRun);
ResearchRunSchema.index({ topicId: 1, number: -1 });
