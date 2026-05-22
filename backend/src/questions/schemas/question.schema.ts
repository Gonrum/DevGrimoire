import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type QuestionDocument = HydratedDocument<Question>;

export type QuestionDirection = 'agent_to_user' | 'user_to_agent';
export type QuestionStatus = 'pending' | 'answered' | 'expired';

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

  /**
   * 'agent_to_user' (default) — agent asks a user for input. Originates from
   * `ask_user` and stays visible after timeout so the user can still respond.
   * 'user_to_agent' — user-initiated follow-up question on a todo (T-247),
   * optionally even on completed todos.
   */
  @Prop({ type: String, enum: ['agent_to_user', 'user_to_agent'], default: 'agent_to_user', index: true })
  direction: QuestionDirection;

  /**
   * Optional metadata so multiple agents/runs can disambiguate which run a
   * pending question belongs to.
   */
  @Prop()
  agentRunId?: string;

  @Prop()
  agentName?: string;

  @Prop({ type: String, enum: ['pending', 'answered', 'expired'], default: 'pending' })
  status: QuestionStatus;

  @Prop()
  answer?: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  answeredByUserId?: Types.ObjectId;

  /** True when the answer was written by an agent (T-247 user→agent flow). */
  @Prop({ type: Boolean, default: false })
  answeredByAgent: boolean;

  @Prop()
  answeredAt?: Date;

  /**
   * Set after a successful convert-to-knowledge operation. Points to the
   * Knowledge entry that was created from this question's Q&A. Bidirectional
   * link: Knowledge.sourceQuestionId points back here.
   */
  @Prop({ type: Types.ObjectId, ref: 'Knowledge' })
  knowledgeId?: Types.ObjectId;

  /**
   * Soft-timeout. Questions whose `expiresAt` is in the past flip to status
   * 'expired' the next time `waitForAnswer` polls them, but the document is
   * NOT deleted — the user can still answer it from the todo detail view.
   * Optional: 'user_to_agent' questions don't have an automatic deadline.
   */
  @Prop({ default: 300000 })
  timeoutMs: number;

  @Prop()
  expiresAt?: Date;
}

export const QuestionSchema = SchemaFactory.createForClass(Question);
QuestionSchema.index({ status: 1, expiresAt: 1 });
QuestionSchema.index({ targetUserId: 1, status: 1 });
QuestionSchema.index({ todoId: 1, status: 1 });
QuestionSchema.index({ projectId: 1, status: 1 });
QuestionSchema.index({ direction: 1, status: 1, createdAt: -1 });
