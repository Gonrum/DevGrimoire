import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ManualDocument = HydratedDocument<Manual>;

@Schema({ timestamps: true })
export class Manual {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, unique: true })
  projectId: Types.ObjectId;

  @Prop({ default: 'Benutzerhandbuch' })
  title: string;

  @Prop({ default: '' })
  content: string;

  @Prop({ default: 'claude' })
  lastEditedBy: string;
}

export const ManualSchema = SchemaFactory.createForClass(Manual);
ManualSchema.index({ projectId: 1 }, { unique: true });
