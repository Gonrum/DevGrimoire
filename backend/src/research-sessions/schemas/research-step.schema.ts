import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ChatMessage, ChatMessageSchema } from '../../chat/schemas/chat-session.schema';

export type ResearchStepDocument = HydratedDocument<ResearchStep>;

export enum ResearchStepStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  DONE = 'done',
}

@Schema({ timestamps: true })
export class ResearchStep {
  @Prop({ type: Types.ObjectId, ref: 'ResearchSession', required: true })
  sessionId: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ enum: ResearchStepStatus, default: ResearchStepStatus.OPEN })
  status: ResearchStepStatus;

  @Prop({ default: 0 })
  order: number;

  /** Conversation embedded in the step (mirrors ChatSession.messages pattern). */
  @Prop({ type: [ChatMessageSchema], default: [] })
  messages: ChatMessage[];

  /** Backlink to the auto-generated `research_*` entry created when status → done. */
  @Prop({ type: Types.ObjectId, ref: 'Research' })
  researchEntryId?: Types.ObjectId;
}

export const ResearchStepSchema = SchemaFactory.createForClass(ResearchStep);
ResearchStepSchema.index({ sessionId: 1, order: 1 });
