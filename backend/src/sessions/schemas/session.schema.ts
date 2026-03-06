import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SessionDocument = HydratedDocument<Session>;

@Schema({ timestamps: true })
export class Session {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  @Prop({ required: true })
  summary: string;

  @Prop({ type: [String], default: [] })
  filesChanged: string[];

  @Prop({ type: [String], default: [] })
  nextSteps: string[];

  @Prop({ type: [String], default: [] })
  openQuestions: string[];
}

export const SessionSchema = SchemaFactory.createForClass(Session);
SessionSchema.index({ projectId: 1, createdAt: -1 });
