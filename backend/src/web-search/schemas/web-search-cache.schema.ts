import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type WebSearchCacheDocument = HydratedDocument<WebSearchCache>;

@Schema({ timestamps: true, collection: 'web_search_cache' })
export class WebSearchCache {
  @Prop({ required: true, unique: true, index: true })
  queryHash: string;

  @Prop({ required: true })
  query: string;

  @Prop({ type: Object, required: true })
  payload: Record<string, unknown>;

  @Prop({ required: true })
  expiresAt: Date;
}

export const WebSearchCacheSchema = SchemaFactory.createForClass(WebSearchCache);
WebSearchCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
