import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type RecurringTaskDocument = RecurringTask & Document;

export enum RecurringFrequency {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  BIWEEKLY = 'biweekly',
  MONTHLY = 'monthly',
  QUARTERLY = 'quarterly',
  YEARLY = 'yearly',
}

export enum RecurringAction {
  /** Default — create a Todo (project/customer scope) or Notification (system scope). */
  TODO = 'todo',
  /** Trigger the internal workflow-agent LLM with a prompt and persist the result as a chat session. */
  CHAT = 'chat',
}

export enum RecurringRunStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

@Schema({ _id: false })
export class RecurringChatConfig {
  @Prop({ required: true })
  prompt: string;

  @Prop()
  systemPrompt?: string;

  @Prop({ type: [String], default: [] })
  allowedTools: string[];

  @Prop()
  agentRoleId?: string;

  @Prop({ default: 60_000, min: 5_000, max: 600_000 })
  timeoutMs: number;

  @Prop({ default: 3, min: 1, max: 20 })
  maxToolIterations: number;

  /**
   * `new` (default): every run creates a fresh chat session.
   * `reuse`: append the run as a new user/assistant pair to the last session
   *           created by this recurring task. Falls back to `new` if none.
   */
  @Prop({ enum: ['new', 'reuse'], default: 'new' })
  sessionStrategy: 'new' | 'reuse';
}

export const RecurringChatConfigSchema = SchemaFactory.createForClass(RecurringChatConfig);

@Schema({ timestamps: true })
export class RecurringTask {
  @Prop({ type: Types.ObjectId, ref: 'Project', index: true })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer', index: true })
  customerId?: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop()
  description?: string;

  @Prop({ enum: ['low', 'medium', 'high', 'critical'] })
  priority?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: Types.ObjectId, ref: 'Milestone' })
  milestoneId?: Types.ObjectId;

  @Prop()
  repoLabel?: string;

  @Prop({ enum: RecurringFrequency, required: true })
  frequency: RecurringFrequency;

  @Prop({ min: 0, max: 6 })
  dayOfWeek?: number;

  @Prop({ min: 1, max: 31 })
  dayOfMonth?: number;

  @Prop({ min: 1, max: 12 })
  month?: number;

  @Prop({ default: 9, min: 0, max: 23 })
  hour: number;

  @Prop({ default: true })
  active: boolean;

  @Prop()
  lastRun?: Date;

  @Prop({ required: true })
  nextRun: Date;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Todo' }], default: [] })
  createdTodoIds: Types.ObjectId[];

  @Prop({ default: 3, min: 1, max: 10 })
  maxCatchUp: number;

  /** Default action — keep 'todo' so legacy recurring tasks behave unchanged. */
  @Prop({ enum: RecurringAction, default: RecurringAction.TODO, index: true })
  action: RecurringAction;

  /** Required when `action === 'chat'`. */
  @Prop({ type: RecurringChatConfigSchema })
  chat?: RecurringChatConfig;

  /** Owning user — required for chat actions so the chat session can be persisted. */
  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdByUserId?: Types.ObjectId;

  /** Chat sessions produced by `action === 'chat'` runs. Most recent last. */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'ChatSession' }], default: [] })
  chatSessionIds: Types.ObjectId[];

  /** Result of the last run — surfaced in the UI so users see failures, not just silence. */
  @Prop({ enum: RecurringRunStatus, default: RecurringRunStatus.PENDING })
  lastRunStatus: RecurringRunStatus;

  /** Sanitized error message from the last failed run. */
  @Prop()
  lastRunError?: string;
}

export const RecurringTaskSchema = SchemaFactory.createForClass(RecurringTask);
RecurringTaskSchema.index({ projectId: 1, active: 1, nextRun: 1 });
RecurringTaskSchema.index({ customerId: 1, active: 1, nextRun: 1 });
