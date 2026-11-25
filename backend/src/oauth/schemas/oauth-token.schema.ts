import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type OAuthTokenDocument = HydratedDocument<OAuthToken>;
export type OAuthTokenType = 'access' | 'refresh';

/**
 * Access (1 h) or refresh (30 days, rotating) token of an OAuth connection.
 * Stored only as SHA-256 hash; the connection is the hidden API key
 * `apiKeyId`, whose scope applies to every request made with the token.
 */
@Schema({ timestamps: true })
export class OAuthToken {
  @Prop({ required: true, unique: true })
  tokenHash: string;

  @Prop({ type: String, enum: ['access', 'refresh'], required: true })
  type: OAuthTokenType;

  @Prop({ required: true })
  clientId: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'ApiKey', required: true, index: true })
  apiKeyId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  resource: string;

  @Prop({ type: [String], default: [] })
  scopes: string[];

  @Prop({ required: true })
  expiresAt: Date;

  /** Refresh tokens only: when this token was rotated out. */
  @Prop()
  replacedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const OAuthTokenSchema = SchemaFactory.createForClass(OAuthToken);
OAuthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
