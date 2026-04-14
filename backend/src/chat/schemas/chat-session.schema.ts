import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ChatSessionDocument = HydratedDocument<ChatSession>;

export interface ChatContextRef {
  entity: string;
  entityId: string;
  title: string;
  score?: number;
}

export interface ChatToolCallRecord {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  success: boolean;
  error?: string;
}

export interface ChatAttachmentRef {
  attachmentId: string;
  fileName: string;
  size: number;
  /** Length of the text that was injected into context, after truncation. */
  extractedLength?: number;
  /** "text" for M-10 text attachments, "image" for M-11 vision uploads. */
  kind?: 'text' | 'image';
}

@Schema({ _id: false })
export class ChatMessage {
  @Prop({ type: String, enum: ['system', 'user', 'assistant'], required: true })
  role: 'system' | 'user' | 'assistant';

  @Prop({ required: true })
  content: string;

  @Prop({ type: Date, default: Date.now })
  timestamp: Date;

  @Prop({
    type: [
      {
        _id: false,
        entity: String,
        entityId: String,
        title: String,
        score: Number,
      },
    ],
    default: undefined,
  })
  contextUsed?: ChatContextRef[];

  @Prop({
    type: [
      {
        _id: false,
        id: String,
        name: String,
        arguments: String,
        result: String,
        success: Boolean,
        error: String,
      },
    ],
    default: undefined,
  })
  toolCalls?: ChatToolCallRecord[];

  @Prop({
    type: [
      {
        _id: false,
        attachmentId: String,
        fileName: String,
        size: Number,
        extractedLength: Number,
        kind: String,
      },
    ],
    default: undefined,
  })
  attachments?: ChatAttachmentRef[];
}

export const ChatMessageSchema = SchemaFactory.createForClass(ChatMessage);

@Schema({ timestamps: true })
export class ChatSession {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ type: [ChatMessageSchema], default: [] })
  messages: ChatMessage[];

  @Prop({ type: Boolean, default: false })
  archived: boolean;

  @Prop({ type: String })
  model?: string;
}

export const ChatSessionSchema = SchemaFactory.createForClass(ChatSession);
ChatSessionSchema.index({ userId: 1, projectId: 1, updatedAt: -1 });
ChatSessionSchema.index({ projectId: 1, updatedAt: -1 });
ChatSessionSchema.index({ archived: 1 });
