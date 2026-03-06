import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ChangelogDocument = HydratedDocument<Changelog>;

@Schema({ timestamps: true })
export class Changelog {
  @Prop({ required: true, index: true })
  projectId: string;

  @Prop()
  version: string;

  @Prop({ type: [String], default: [] })
  changes: string[];

  @Prop()
  summary: string;

  @Prop()
  component: string;
}

export const ChangelogSchema = SchemaFactory.createForClass(Changelog);
ChangelogSchema.index({ projectId: 1, createdAt: -1 });
