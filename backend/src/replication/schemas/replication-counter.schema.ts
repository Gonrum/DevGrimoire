import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ReplicationCounterDocument = HydratedDocument<ReplicationCounter>;

/** Single-document atomic sequence generator for replication_log.seq.
 *  Keyed by a `key` field (not a custom _id) to keep Mongoose's default
 *  ObjectId _id and avoid custom-_id reflection edge cases. */
@Schema({ collection: 'replication_counters' })
export class ReplicationCounter {
  /** Fixed counter key, e.g. 'replication_log'. */
  @Prop({ type: String, required: true, unique: true })
  key: string;

  @Prop({ required: true, default: 0 })
  seq: number;
}

export const ReplicationCounterSchema = SchemaFactory.createForClass(ReplicationCounter);
ReplicationCounterSchema.index({ key: 1 }, { unique: true });
