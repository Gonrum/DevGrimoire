import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { LLM_PROVIDER_KINDS, LLM_PURPOSES } from '../balancer.types';

export type LlmEndpointDocument = HydratedDocument<LlmEndpoint>;

@Schema({ timestamps: true, collection: 'llmendpoints' })
export class LlmEndpoint {
  @Prop({ required: true }) label: string;
  @Prop({ required: true, enum: LLM_PROVIDER_KINDS as unknown as string[] }) provider: string;
  @Prop({ required: true }) baseUrl: string;
  @Prop({ required: true }) model: string;
  @Prop() apiKeyEnc?: string;
  @Prop({ type: [String], enum: LLM_PURPOSES as unknown as string[], default: [] }) purposes: string[];
  @Prop({ default: false }) visionCapable: boolean;
  @Prop({ default: 1, min: 0, max: 16 }) concurrency: number;
  @Prop({ default: 100 }) priority: number;
  @Prop({ default: 0 }) timeoutMs: number;
  @Prop({ default: true }) enabled: boolean;
}

export const LlmEndpointSchema = SchemaFactory.createForClass(LlmEndpoint);
LlmEndpointSchema.index({ purposes: 1, priority: 1 });
