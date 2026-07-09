import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ResearchArtifactVersionDocument = HydratedDocument<ResearchArtifactVersion>;

@Schema({ timestamps: true })
export class ResearchArtifactVersion {
  @Prop({ type: Types.ObjectId, ref: 'ResearchArtifact', required: true })
  artifactId: Types.ObjectId;

  @Prop({ required: true })
  version: number;

  @Prop({ required: true })
  content: string;

  @Prop()
  changeNote?: string;

  @Prop({ type: Types.ObjectId })
  runId?: Types.ObjectId;
}

export const ResearchArtifactVersionSchema = SchemaFactory.createForClass(ResearchArtifactVersion);
ResearchArtifactVersionSchema.index({ artifactId: 1, version: -1 });
