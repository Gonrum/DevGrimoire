import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ _id: false })
export class HistoryHeader {
  @Prop() name: string;
  @Prop() value: string;
}
export const HistoryHeaderSchema = SchemaFactory.createForClass(HistoryHeader);

export type RequestHistoryDocument = HydratedDocument<RequestHistoryEntry>;

@Schema({ timestamps: true, collection: 'http_request_history' })
export class RequestHistoryEntry {
  @Prop({ type: Types.ObjectId, ref: 'SavedRequest', required: true, index: true })
  requestId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'RequestCollection' })
  collectionId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Project', index: true })
  projectId?: Types.ObjectId;

  @Prop({ required: true })
  sentAt: Date;

  @Prop({ default: 0 })
  durationMs: number;

  @Prop({ default: false })
  ok: boolean;

  // ---- Masked request snapshot (secret values already redacted) ----
  @Prop() method: string;
  @Prop() url: string;
  @Prop({ type: [HistoryHeaderSchema], default: [] })
  requestHeaders: HistoryHeader[];
  @Prop() requestBody?: string;
  @Prop({ type: Types.ObjectId, ref: 'Environment' })
  environmentId?: Types.ObjectId;
  @Prop() environmentName?: string;

  // ---- Response ----
  @Prop() status?: number;
  @Prop() statusText?: string;
  @Prop({ type: [HistoryHeaderSchema], default: [] })
  responseHeaders: HistoryHeader[];
  @Prop({ default: '' }) bodyText: string;
  @Prop({ default: false }) truncated: boolean;
  @Prop({ default: 0 }) bodySize: number;
  @Prop() contentType?: string;
  @Prop() error?: string;

  // TTL — MongoDB removes the doc once expiresAt <= now.
  @Prop({ required: true })
  expiresAt: Date;
}

export const RequestHistorySchema = SchemaFactory.createForClass(RequestHistoryEntry);
RequestHistorySchema.index({ requestId: 1, sentAt: -1 });
RequestHistorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
