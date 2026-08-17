import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type ReplicationLogDocument = HydratedDocument<ReplicationLog>;

@Schema({ timestamps: true, collection: 'replication_log' })
export class ReplicationLog {
  /** Monotonic cursor key (from ReplicationCounter). Strictly increasing; rare gaps are possible when an idempotent crash-resume replay discards a number — harmless, the cursor walk is `seq > cursor` and never assumes compactness. */
  @Prop({ required: true })
  seq: number;

  /** Idempotency key `collection:_id:<resumeTokenData> (clusterTimeMs only as fallback)` — dedups crash-resume. */
  @Prop({ required: true })
  eventId: string;

  @Prop({ required: true, enum: ['upsert', 'delete'] })
  op: string;

  @Prop({ required: true })
  collection: string;

  @Prop({ required: true })
  documentId: string;

  @Prop({ type: String, default: null })
  projectId: string | null;

  /** Multi-project entities (e.g. ResearchTopic) carry their project array here;
   *  `projectId` stays null for them. null for single-project entities. */
  @Prop({ type: [String], default: null })
  projectIds: string[] | null;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  document: Record<string, unknown> | null;

  /** For LWW on the receiver (ms epoch). null when unknown. */
  @Prop({ type: Number, default: null })
  updatedAtMs: number | null;

  /** Delete timestamp for LWW on delete ops (ms epoch). null for upserts. */
  @Prop({ type: Number, default: null })
  deletedAtMs: number | null;

  /** Originating instance id: self for local writes, remote for applied changes. */
  @Prop({ required: true })
  originInstanceId: string;

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const ReplicationLogSchema = SchemaFactory.createForClass(ReplicationLog);
ReplicationLogSchema.index({ seq: 1 }, { unique: true });
ReplicationLogSchema.index({ eventId: 1 }, { unique: true });
ReplicationLogSchema.index({ createdAt: 1 });
ReplicationLogSchema.index({ originInstanceId: 1, seq: 1 });
