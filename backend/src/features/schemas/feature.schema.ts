import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type FeatureDocument = Feature & Document;

export enum FeatureStatus {
  PLANNED = 'planned',
  IN_DEVELOPMENT = 'in_development',
  RELEASED = 'released',
  DEPRECATED = 'deprecated',
}

export enum FeaturePriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

@Schema({ timestamps: true })
export class Feature {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop()
  category?: string;

  @Prop({ enum: FeatureStatus, default: FeatureStatus.PLANNED })
  status: FeatureStatus;

  @Prop()
  version?: string;

  @Prop({ enum: FeaturePriority })
  priority?: FeaturePriority;

  @Prop({ type: [String], default: [] })
  tags: string[];
}

export const FeatureSchema = SchemaFactory.createForClass(Feature);

FeatureSchema.index({ projectId: 1, name: 1 }, { unique: true });
FeatureSchema.index({ projectId: 1, status: 1 });
FeatureSchema.index({ projectId: 1, category: 1 });
FeatureSchema.index({ name: 'text', description: 'text' });
