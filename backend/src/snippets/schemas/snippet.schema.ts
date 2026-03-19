import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SnippetDocument = HydratedDocument<Snippet>;

@Schema({ timestamps: true })
export class Snippet {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  language: string;

  @Prop({ required: true })
  code: string;

  @Prop()
  description?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: String })
  category?: string;

  @Prop()
  fileName?: string;
}

export const SnippetSchema = SchemaFactory.createForClass(Snippet);
SnippetSchema.index({ projectId: 1 });
SnippetSchema.index(
  { title: 'text', code: 'text', description: 'text', tags: 'text' },
  { language_override: 'textSearchLanguage' },
);
