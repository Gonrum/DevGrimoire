import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ALL_SENSITIVITY_LEVELS, Sensitivity, SensitivityLevel } from '../../common/sensitivity';

export type KnowledgeDocument = HydratedDocument<Knowledge>;

@Schema({ timestamps: true })
export class Knowledge {
  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  @Prop({ type: String, enum: ['global', 'project', 'customer'], default: 'project' })
  scope: string;

  @Prop({ required: true })
  topic: string;

  @Prop({ required: true })
  content: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: String })
  category?: string;

  // Data classification. `confidential`/`personal`/`secret` skip RAG indexing.
  // Default `internal` keeps existing data behaving as before. See knowledge
  // entry T-219 for the policy and isExcludedFromRag() helper for the check.
  @Prop({ type: String, enum: ALL_SENSITIVITY_LEVELS, default: Sensitivity.INTERNAL })
  sensitivity: SensitivityLevel;
}

export const KnowledgeSchema = SchemaFactory.createForClass(Knowledge);
KnowledgeSchema.index({ projectId: 1 });
KnowledgeSchema.index({ customerId: 1 });
KnowledgeSchema.index({ scope: 1 });
KnowledgeSchema.index({ topic: 'text', content: 'text', tags: 'text' });
