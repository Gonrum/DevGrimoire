import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ApiKeyDocument = HydratedDocument<ApiKey>;

@Schema({ timestamps: true })
export class ApiKey {
  @Prop({ required: true, unique: true })
  keyHash: string;

  @Prop({ required: true })
  prefix: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop()
  lastUsedAt: Date;

  @Prop()
  expiresAt: Date;

  @Prop({ default: true })
  active: boolean;
}

export const ApiKeySchema = SchemaFactory.createForClass(ApiKey);
ApiKeySchema.index({ userId: 1 });
ApiKeySchema.index({ keyHash: 1 }, { unique: true });
