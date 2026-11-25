import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OAuthClientDocument = HydratedDocument<OAuthClient>;

/**
 * A dynamically registered OAuth client (RFC 7591). Only the fields the
 * server enforces or shows on the consent page are kept; every client is a
 * public client (`token_endpoint_auth_method: 'none'`, PKCE mandatory), so
 * there is no client secret to store.
 */
@Schema({ timestamps: true })
export class OAuthClient {
  @Prop({ required: true, unique: true })
  clientId: string;

  @Prop()
  clientName?: string;

  @Prop({ type: [String], required: true })
  redirectUris: string[];

  /** Seconds since epoch, as returned in `client_id_issued_at`. */
  @Prop({ required: true })
  issuedAt: number;

  /**
   * Set at registration, removed on the first approval: a client nobody ever
   * approved is deleted by the TTL index after 24 h.
   */
  @Prop()
  expiresAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const OAuthClientSchema = SchemaFactory.createForClass(OAuthClient);
OAuthClientSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
