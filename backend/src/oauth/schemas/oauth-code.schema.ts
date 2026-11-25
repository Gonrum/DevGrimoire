import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { CODE_REPLAY_RETENTION_SEC } from '../oauth-tokens';

export type OAuthCodeDocument = HydratedDocument<OAuthCode>;

/**
 * Authorization code: single use, valid 60 s, PKCE S256. Stored only as its
 * SHA-256 hash. Bound to the connection (hidden API key) created at approval.
 */
@Schema({ timestamps: true })
export class OAuthCode {
  @Prop({ required: true, unique: true })
  codeHash: string;

  @Prop({ required: true })
  clientId: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'ApiKey', required: true, index: true })
  apiKeyId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  redirectUri: string;

  @Prop({ required: true })
  codeChallenge: string;

  @Prop({ type: [String], default: [] })
  scopes: string[];

  @Prop({ required: true })
  resource: string;

  /** End of validity. The document itself lives a little longer (replay detection). */
  @Prop({ required: true })
  expiresAt: Date;

  @Prop()
  usedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const OAuthCodeSchema = SchemaFactory.createForClass(OAuthCode);
OAuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: CODE_REPLAY_RETENTION_SEC });
