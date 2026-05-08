import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SnippetDocument = HydratedDocument<Snippet>;

@Schema({ timestamps: true })
export class Snippet {
  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

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
SnippetSchema.index({ customerId: 1 });
SnippetSchema.index(
  { title: 'text', code: 'text', description: 'text', tags: 'text' },
  { language_override: 'textSearchLanguage' },
);
