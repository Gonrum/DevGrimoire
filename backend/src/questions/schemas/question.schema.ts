import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type QuestionDocument = HydratedDocument<Question>;

@Schema({ timestamps: true })
export class Question {
  @Prop({ required: true })
  question: string;

  @Prop({ type: [String], default: [] })
  options: string[];

  @Prop()
  context?: string;

  @Prop({ type: Types.ObjectId, ref: 'Todo' })
  todoId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  targetUserId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdByUserId?: Types.ObjectId;

  @Prop({ type: String, enum: ['pending', 'answered', 'expired'], default: 'pending' })
  status: string;

  @Prop()
  answer?: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  answeredByUserId?: Types.ObjectId;

  @Prop()
  answeredAt?: Date;

  @Prop({ default: 300000 })
  timeoutMs: number;

  @Prop({ required: true })
  expiresAt: Date;
}

export const QuestionSchema = SchemaFactory.createForClass(Question);
QuestionSchema.index({ status: 1, expiresAt: 1 });
QuestionSchema.index({ targetUserId: 1, status: 1 });
QuestionSchema.index({ todoId: 1 });
QuestionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
