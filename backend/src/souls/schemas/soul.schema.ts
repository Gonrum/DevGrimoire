import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SoulDocument = HydratedDocument<Soul>;

@Schema({ timestamps: true })
export class Soul {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  @Prop({ default: '' })
  vision: string;

  @Prop({ default: '' })
  principles: string;

  @Prop({ default: '' })
  conventions: string;

  @Prop({ default: '' })
  communication: string;

  @Prop({ default: '' })
  boundaries: string;

  @Prop({ default: '' })
  workflow: string;

  @Prop({ default: '' })
  quality: string;
}

export const SoulSchema = SchemaFactory.createForClass(Soul);
SoulSchema.index({ projectId: 1 }, { unique: true });
