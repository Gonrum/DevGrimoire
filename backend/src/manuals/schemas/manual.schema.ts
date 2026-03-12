import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ManualDocument = HydratedDocument<Manual>;

@Schema({ timestamps: true })
export class Manual {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ default: '' })
  content: string;

  @Prop()
  category?: string;

  @Prop({ default: 0 })
  sortOrder: number;

  @Prop({ default: 'claude' })
  lastEditedBy: string;
}

export const ManualSchema = SchemaFactory.createForClass(Manual);
ManualSchema.index({ projectId: 1 });
ManualSchema.index({ projectId: 1, category: 1, sortOrder: 1 });
ManualSchema.index({ title: 'text', content: 'text' });
