import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export enum HealthcheckMethod {
  GET = 'GET',
  POST = 'POST',
  HEAD = 'HEAD',
  PUT = 'PUT',
  PATCH = 'PATCH',
  DELETE = 'DELETE',
}

export enum HealthcheckStatus {
  UNKNOWN = 'unknown',
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy',
  PAUSED = 'paused',
}

@Schema({ _id: false })
export class HealthcheckHeader {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ default: '' })
  value: string;
}
export const HealthcheckHeaderSchema = SchemaFactory.createForClass(HealthcheckHeader);

@Schema({ _id: false })
export class HealthcheckSecretHeader {
  @Prop({ required: true, trim: true })
  name: string;

  // Reference to a Secret document. Stored as ObjectId so cascading delete on
  // the Secret can null this entry; resolution happens at execution time.
  @Prop({ type: Types.ObjectId, ref: 'Secret', required: true })
  secretId: Types.ObjectId;
}
export const HealthcheckSecretHeaderSchema = SchemaFactory.createForClass(HealthcheckSecretHeader);

export type HealthcheckDocument = HydratedDocument<Healthcheck>;

@Schema({ timestamps: true, collection: 'healthchecks' })
export class Healthcheck {
  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true, index: true })
  customerId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'CustomerProjectLink' })
  customerProjectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Environment' })
  environmentId?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop()
  description?: string;

  @Prop({ type: String, enum: HealthcheckMethod, default: HealthcheckMethod.GET })
  method: HealthcheckMethod;

  @Prop({ required: true, trim: true })
  url: string;

  @Prop({ type: [HealthcheckHeaderSchema], default: [] })
  headers: HealthcheckHeader[];

  @Prop({ type: [HealthcheckSecretHeaderSchema], default: [] })
  secretHeaders: HealthcheckSecretHeader[];

  @Prop()
  body?: string;

  @Prop({ default: 'application/json' })
  contentType?: string;

  // 60 = once per minute (scheduler granularity). Min enforced by DTO.
  @Prop({ required: true, default: 300, min: 60 })
  intervalSeconds: number;

  @Prop({ required: true, default: 10000, min: 500, max: 120000 })
  timeoutMs: number;

  // Allowed HTTP statuses. Empty = anything 2xx counts as success.
  @Prop({ type: [Number], default: [] })
  expectedStatus: number[];

  // Optional substring that must appear in response body. Empty = no body check.
  @Prop({ default: '' })
  expectedContent?: string;

  // Number of consecutive failures required before flipping to UNHEALTHY.
  @Prop({ required: true, default: 2, min: 1, max: 20 })
  failureThreshold: number;

  @Prop({ default: true })
  active: boolean;

  // Runtime state (updated by scheduler/service)
  @Prop({ type: String, enum: HealthcheckStatus, default: HealthcheckStatus.UNKNOWN, index: true })
  lastStatus: HealthcheckStatus;

  @Prop()
  lastRunAt?: Date;

  @Prop()
  lastLatencyMs?: number;

  @Prop()
  lastStatusCode?: number;

  @Prop()
  lastError?: string;

  @Prop({ default: 0 })
  consecutiveFailures: number;

  @Prop({ default: 0 })
  consecutiveSuccesses: number;

  // Used by the scheduler to find due checks.
  @Prop({ index: true })
  nextRunAt?: Date;

  // Notification debouncing — only emit on transitions, not every run.
  @Prop({ type: String, enum: HealthcheckStatus, default: HealthcheckStatus.UNKNOWN })
  lastNotifiedStatus?: HealthcheckStatus;
}

export const HealthcheckSchema = SchemaFactory.createForClass(Healthcheck);
HealthcheckSchema.index({ customerId: 1, name: 1 }, { unique: true });
HealthcheckSchema.index({ active: 1, nextRunAt: 1 });
HealthcheckSchema.index({ projectId: 1 });
HealthcheckSchema.index({ environmentId: 1 });
