import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ResearchDocument = HydratedDocument<Research>;

@Schema({ timestamps: true })
export class Research {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  content: string;

  @Prop({ type: [String], default: [] })
  sources: string[];

  @Prop({ type: [String], default: [] })
  tags: string[];
}

export const ResearchSchema = SchemaFactory.createForClass(Research);
ResearchSchema.index({ projectId: 1 });
ResearchSchema.index({ title: 'text', content: 'text', tags: 'text' });
