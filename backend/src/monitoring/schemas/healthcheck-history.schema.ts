import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { HealthcheckStatus } from './healthcheck.schema';

export type HealthcheckHistoryDocument = HydratedDocument<HealthcheckHistory>;

@Schema({ timestamps: true, collection: 'healthcheck_history' })
export class HealthcheckHistory {
  @Prop({ type: Types.ObjectId, ref: 'Healthcheck', required: true, index: true })
  healthcheckId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true, index: true })
  customerId: Types.ObjectId;

  @Prop({ required: true })
  runAt: Date;

  @Prop({ type: String, enum: HealthcheckStatus, required: true })
  status: HealthcheckStatus;

  @Prop()
  statusCode?: number;

  @Prop()
  latencyMs?: number;

  @Prop()
  error?: string;

  // TTL field — MongoDB removes the document automatically once expiresAt <= now.
  @Prop({ required: true })
  expiresAt: Date;
}

export const HealthcheckHistorySchema = SchemaFactory.createForClass(HealthcheckHistory);
HealthcheckHistorySchema.index({ healthcheckId: 1, runAt: -1 });
HealthcheckHistorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
