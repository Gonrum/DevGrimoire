import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ChangelogDocument = HydratedDocument<Changelog>;

@Schema({ timestamps: true })
export class Changelog {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId: Types.ObjectId;

  @Prop()
  version: string;

  @Prop({ type: [String], default: [] })
  changes: string[];

  @Prop()
  summary: string;

  @Prop()
  component: string;

  @Prop()
  repoLabel: string;

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const ChangelogSchema = SchemaFactory.createForClass(Changelog);
ChangelogSchema.index({ projectId: 1, createdAt: -1 });
