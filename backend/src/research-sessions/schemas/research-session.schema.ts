import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ResearchSessionDocument = HydratedDocument<ResearchSession>;

export enum ResearchSessionStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  DONE = 'done',
}

@Schema({ timestamps: true })
export class ResearchSession {
  @Prop({ required: true })
  title: string;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Project' }], default: [] })
  projectIds: Types.ObjectId[];

  @Prop({ enum: ResearchSessionStatus, default: ResearchSessionStatus.OPEN })
  status: ResearchSessionStatus;

  @Prop()
  number: number;

  @Prop()
  displayNumber: string;
}

export const ResearchSessionSchema = SchemaFactory.createForClass(ResearchSession);
ResearchSessionSchema.index(
  { number: 1 },
  { unique: true, partialFilterExpression: { number: { $type: 'number' } } },
);
ResearchSessionSchema.index({ projectIds: 1, status: 1, updatedAt: -1 });
