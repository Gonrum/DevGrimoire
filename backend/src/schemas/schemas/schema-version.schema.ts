import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { SchemaField, SchemaIndex } from './db-schema.schema';

export type SchemaVersionDocument = HydratedDocument<SchemaVersion>;

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class SchemaVersion {
  @Prop({ type: Types.ObjectId, ref: 'DbSchema', required: true })
  schemaId: Types.ObjectId;

  @Prop({ required: true })
  version: number;

  @Prop({ type: [Object], default: [] })
  fields: SchemaField[];

  @Prop({ type: [Object], default: [] })
  indexes: SchemaIndex[];

  @Prop()
  changeNote?: string;

  // `timestamps` legt diese Felder zur Laufzeit an, deklariert sie aber nicht
  // am Typ — ohne Deklaration brauchten Leser dafür ein `as any`.
  // updatedAt ist am Schema bewusst abgeschaltet (Versions-Snapshots sind unveränderlich).
  createdAt?: Date;
}

export const SchemaVersionSchema = SchemaFactory.createForClass(SchemaVersion);
SchemaVersionSchema.index({ schemaId: 1, version: 1 }, { unique: true });
SchemaVersionSchema.index({ schemaId: 1, createdAt: -1 });
