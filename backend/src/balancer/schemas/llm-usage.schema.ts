import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type LlmUsageDocument = HydratedDocument<LlmUsageRecord>;

@Schema({ collection: 'llmusagerecords' })
export class LlmUsageRecord {
  @Prop({ default: () => new Date(), expires: 60 * 60 * 24 * 30 }) ts: Date; // 30d TTL
  @Prop({ required: true }) purpose: string;
  @Prop({ required: true }) endpointId: string;
  @Prop() model: string;
  @Prop({ default: 0 }) promptTokens: number;
  @Prop({ default: 0 }) completionTokens: number;
  @Prop({ default: 0 }) totalTokens: number;
  @Prop({ default: 0 }) durationMs: number;
  @Prop({ required: true }) status: string; // ok|error|cancelled
  @Prop() error?: string;
}

export const LlmUsageSchema = SchemaFactory.createForClass(LlmUsageRecord);
