import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type WebFetchCacheDocument = HydratedDocument<WebFetchCache>;

@Schema({ timestamps: true, collection: 'web_fetch_cache' })
export class WebFetchCache {
  @Prop({ required: true, unique: true, index: true })
  urlHash: string;

  @Prop({ required: true })
  url: string;

  @Prop({ type: Object, required: true })
  payload: Record<string, unknown>;

  @Prop({ required: true })
  expiresAt: Date;
}

export const WebFetchCacheSchema = SchemaFactory.createForClass(WebFetchCache);
WebFetchCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
