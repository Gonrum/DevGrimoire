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
}

export const RecurringTaskSchema = SchemaFactory.createForClass(RecurringTask);
RecurringTaskSchema.index({ projectId: 1, active: 1, nextRun: 1 });
RecurringTaskSchema.index({ customerId: 1, active: 1, nextRun: 1 });
