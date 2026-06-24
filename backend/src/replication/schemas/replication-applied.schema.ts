import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ReplicationAppliedDocument = HydratedDocument<ReplicationApplied>;

/**
 * Short-lived loopback-suppression record. Written by the apply path (Plan 2)
 * BEFORE a remote change is written locally; read by the log writer to tag the
 * resulting change event with the remote origin instead of self. TTL auto-GCs.
 */
@Schema({ timestamps: true, collection: 'replication_applied' })
export class ReplicationApplied {
  /** `collection:_id:updatedAtMs` — matches the exact write being applied. */
  @Prop({ required: true })
  appliedKey: string;

  @Prop({ required: true })
  originInstanceId: string;
}

export const ReplicationAppliedSchema = SchemaFactory.createForClass(ReplicationApplied);
ReplicationAppliedSchema.index({ appliedKey: 1 }, { unique: true });
// TTL: auto-delete 300s after creation.
ReplicationAppliedSchema.index({ createdAt: 1 }, { expireAfterSeconds: 300 });
