import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { SyncLogEntry } from '../replication-sync.types';

export type ReplicationDeadletterDocument = HydratedDocument<ReplicationDeadletter>;

/**
 * One record per (direction, eventId). Tracks retry attempts of a
 * non-applicable entry and, once it gives up, holds the full payload for
 * inspection/replay so nothing is silently lost (spec §5.4, §8.2).
 *   status: 'retrying'  — still being retried each cycle (attempts < max)
 *           'pending'   — gave up; deadlettered, cursor advanced past it
 *           'replayed'  — admin re-applied successfully
 *           'discarded' — admin discarded
 */
@Schema({ timestamps: true, collection: 'replication_deadletter' })
export class ReplicationDeadletter {
  @Prop({ required: true, enum: ['inbound', 'outbound'] })
  direction: string;

  @Prop({ required: true })
  seq: number;

  @Prop({ required: true })
  eventId: string;

  @Prop({ required: true })
  collection: string;

  @Prop({ required: true })
  documentId: string;

  @Prop({ type: String, default: null })
  projectId: string | null;

  /** Full SyncLogEntry payload — the source of truth for a replay. Zur Laufzeit
   *  Mixed (also beliebiges BSON); der TS-Typ ist die Absicht, damit Schreiber
   *  und Replay-Pfad ohne Doppel-Cast arbeiten. Der Replay prüft die Felder
   *  ohnehin selbst — ein Payload aus einer älteren Version scheitert dort mit
   *  einem Outcome, nicht an einem Typ. */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload: SyncLogEntry;

  @Prop({ required: true })
  reason: string;

  @Prop({ required: true, default: 1 })
  attempts: number;

  @Prop({ required: true, enum: ['retrying', 'pending', 'replayed', 'discarded'], default: 'retrying' })
  status: string;

  @Prop({ type: Date, default: null })
  firstFailedAt: Date | null;

  @Prop({ type: Date, default: null })
  lastFailedAt: Date | null;
}

export const ReplicationDeadletterSchema = SchemaFactory.createForClass(ReplicationDeadletter);
ReplicationDeadletterSchema.index({ direction: 1, eventId: 1 }, { unique: true });
ReplicationDeadletterSchema.index({ status: 1 });
