import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OAuthAuthRequestDocument = HydratedDocument<OAuthAuthRequest>;

/**
 * A validated /authorize request waiting for the user's decision on the
 * consent page. Single use, 10 minutes. The request id travels in the
 * consent URL and is stored only as its SHA-256 hash.
 */
@Schema({ timestamps: true })
export class OAuthAuthRequest {
  @Prop({ required: true, unique: true })
  requestHash: string;

  @Prop({ required: true })
  clientId: string;

  /** Snapshot of the client name at request time, shown on the consent page. */
  @Prop()
  clientName?: string;

  @Prop({ required: true })
  redirectUri: string;

  @Prop({ required: true })
  codeChallenge: string;

  @Prop()
  state?: string;

  @Prop({ type: [String], default: [] })
  scopes: string[];

  @Prop({ required: true })
  resource: string;

  @Prop({ required: true })
  expiresAt: Date;

  /** Set when the request is decided; a used request can never be decided again. */
  @Prop()
  usedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const OAuthAuthRequestSchema = SchemaFactory.createForClass(OAuthAuthRequest);
OAuthAuthRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
