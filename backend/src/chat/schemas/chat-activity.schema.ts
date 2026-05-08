import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ChatActivityDocument = HydratedDocument<ChatActivity>;

export type ChatActivityOutcome = 'completed' | 'aborted' | 'failed' | 'no_endpoint';

export interface ChatActivityToolUse {
  name: string;
  count: number;
  errors: number;
}

/**
 * One record per chat completion attempt — used to analyse which endpoints
 * are stable, which tools fire most often, and how often calls fail. Persisted
 * even on failure (see {@link ChatActivityOutcome}). Visible only to admins.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class ChatActivity {
  @Prop({ type: Types.ObjectId, ref: 'ChatSession', index: true })
  sessionId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  userId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Project', index: true })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer', index: true })
  customerId?: Types.ObjectId;

  /** 'server' (HTTP-streamed) or 'browser' (browser-mode + persist endpoint). */
  @Prop({ type: String, enum: ['server', 'browser'], required: true })
  mode: 'server' | 'browser';

  /** LLM provider used (openai-compatible / lmstudio / anthropic / openai). */
  @Prop({ type: String })
  provider?: string;

  /** Endpoint URL the call was sent to. */
  @Prop({ type: String })
  endpointUrl?: string;

  /** Model name. */
  @Prop({ type: String })
  model?: string;

  /** Whether the request used tool-calling. */
  @Prop({ type: Boolean, default: false })
  toolsEnabled: boolean;

  /** Names + counts of tools the model called and whether they errored. */
  @Prop({
    type: [{ _id: false, name: String, count: Number, errors: Number }],
    default: undefined,
  })
  toolsUsed?: ChatActivityToolUse[];

  @Prop({ type: String, enum: ['completed', 'aborted', 'failed', 'no_endpoint'], required: true })
  outcome: ChatActivityOutcome;

  /** Error message when outcome is 'failed' / 'no_endpoint'. */
  @Prop({ type: String })
  errorMessage?: string;

  /** Output tokens (estimated unless provider returned usage). */
  @Prop({ type: Number })
  outputTokens?: number;

  /** Total wall-clock from accept to last token, in ms. */
  @Prop({ type: Number })
  durationMs?: number;

  /** Time-to-first-token in ms. */
  @Prop({ type: Number })
  firstTokenMs?: number;

  /** outputTokens / (durationMs - firstTokenMs). */
  @Prop({ type: Number })
  tokensPerSecond?: number;

  /** Whether the token count is estimated. */
  @Prop({ type: Boolean })
  estimated?: boolean;

  /** Whether the request also carried image attachments. */
  @Prop({ type: Boolean, default: false })
  hadImages: boolean;

  /** Length of the user's input message (chars). */
  @Prop({ type: Number })
  userMessageLength?: number;
}

export const ChatActivitySchema = SchemaFactory.createForClass(ChatActivity);
ChatActivitySchema.index({ createdAt: -1 });
ChatActivitySchema.index({ outcome: 1, createdAt: -1 });
ChatActivitySchema.index({ projectId: 1, createdAt: -1 });
