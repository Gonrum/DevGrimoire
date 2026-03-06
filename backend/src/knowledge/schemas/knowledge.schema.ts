import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type KnowledgeDocument = HydratedDocument<Knowledge>;

@Schema({ timestamps: true })
export class Knowledge {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  @Prop({ required: true })
  topic: string;

  @Prop({ required: true })
  content: string;

  @Prop({ type: [String], default: [] })
  tags: string[];
}

export const KnowledgeSchema = SchemaFactory.createForClass(Knowledge);
KnowledgeSchema.index({ projectId: 1 });
KnowledgeSchema.index({ topic: 'text', content: 'text', tags: 'text' });
