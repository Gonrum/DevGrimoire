import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AuditLogDocument = HydratedDocument<AuditLog>;

/**
 * Append-only audit trail for security-relevant events. Records who did what,
 * when, and against which entity. Replaces the lightweight `Logger.warn` traces
 * scattered across api-keys/auth services with a structured store the admin UI
 * can query. See knowledge entry T-214 for the policy.
 */
@Schema({ timestamps: { createdAt: 'timestamp', updatedAt: false } })
export class AuditLog {
  /** Action taken — `domain.action` lowercase snake (e.g. `apikey.scope_changed`). */
  @Prop({ required: true, index: true })
  action: string;

  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  actorUserId?: Types.ObjectId;

  @Prop()
  actorUsername?: string;

  @Prop()
  actorRole?: string;

  @Prop({ type: Types.ObjectId, ref: 'ApiKey' })
  actorApiKeyId?: Types.ObjectId;

  /** Optional: entity affected by the action — entityType is the lowercase singular. */
  @Prop({ index: true })
  entityType?: string;

  @Prop({ type: Types.ObjectId, index: true })
  entityId?: Types.ObjectId;

  /** Free-form structured payload — diff snippets, scope before/after, etc. */
  @Prop({ type: Object })
  meta?: Record<string, unknown>;

  @Prop()
  ipAddress?: string;

  @Prop()
  userAgent?: string;

  /** Set automatically by Mongoose timestamps. */
  timestamp?: Date;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ timestamp: -1 });
AuditLogSchema.index({ action: 1, timestamp: -1 });
AuditLogSchema.index({ actorUserId: 1, timestamp: -1 });
AuditLogSchema.index({ entityType: 1, entityId: 1, timestamp: -1 });
