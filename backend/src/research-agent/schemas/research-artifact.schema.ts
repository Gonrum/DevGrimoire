import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ALL_SENSITIVITY_LEVELS, Sensitivity, SensitivityLevel } from '../../common/sensitivity';

export type ResearchArtifactDocument = HydratedDocument<ResearchArtifact>;

/** Identity key artifacts are upserted against within a topic. */
export const ARTIFACT_UNIQUE = { topicId: 1, slug: 1 } as const;

@Schema({ timestamps: true })
export class ResearchArtifact {
  @Prop({ type: Types.ObjectId, ref: 'ResearchTopic', required: true })
  topicId: Types.ObjectId;

  @Prop({ required: true })
  slug: string;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  content: string;

  @Prop()
  summary?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: [String], default: [] })
  sources: string[];

  @Prop({ default: 1 })
  version: number;

  // Data classification (mirrors research.schema.ts). confidential/personal/secret skip RAG.
  @Prop({ type: String, enum: ALL_SENSITIVITY_LEVELS, default: Sensitivity.INTERNAL })
  sensitivity: SensitivityLevel;

  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  @Prop({ default: false })
  isGlobal: boolean;

  @Prop({ type: Types.ObjectId })
  lastRunId?: Types.ObjectId;
}

export const ResearchArtifactSchema = SchemaFactory.createForClass(ResearchArtifact);
ResearchArtifactSchema.index(ARTIFACT_UNIQUE, { unique: true });
ResearchArtifactSchema.index({ topicId: 1, updatedAt: -1 });
