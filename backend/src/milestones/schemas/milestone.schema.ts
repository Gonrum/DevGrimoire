import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type MilestoneDocument = HydratedDocument<Milestone>;

export enum MilestoneStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  DONE = 'done',
}

@Schema({ timestamps: true })
export class Milestone {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop()
  description: string;

  @Prop({ enum: MilestoneStatus, default: MilestoneStatus.OPEN })
  status: MilestoneStatus;

  @Prop()
  dueDate: Date;

  @Prop({ default: false })
  archived: boolean;

  @Prop({ type: Types.ObjectId, ref: 'Changelog' })
  changelogId: Types.ObjectId;

  @Prop()
  number: number;

  @Prop()
  displayNumber: string;
}

export const MilestoneSchema = SchemaFactory.createForClass(Milestone);
MilestoneSchema.index({ projectId: 1, status: 1, createdAt: -1 });
MilestoneSchema.index(
  { projectId: 1, number: 1 },
  { unique: true, partialFilterExpression: { number: { $type: 'number' } } },
);
