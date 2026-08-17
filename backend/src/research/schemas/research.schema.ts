import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ALL_SENSITIVITY_LEVELS, Sensitivity, SensitivityLevel } from '../../common/sensitivity';

export type ResearchDocument = HydratedDocument<Research>;

@Schema({ timestamps: true })
export class Research {
  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  content: string;

  @Prop({ type: [String], default: [] })
  sources: string[];

  @Prop({ type: [String], default: [] })
  tags: string[];

  // Data classification (T-219). confidential/personal/secret skip RAG.
  @Prop({ type: String, enum: ALL_SENSITIVITY_LEVELS, default: Sensitivity.INTERNAL })
  sensitivity: SensitivityLevel;

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const ResearchSchema = SchemaFactory.createForClass(Research);
ResearchSchema.index({ projectId: 1 });
ResearchSchema.index({ customerId: 1 });
ResearchSchema.index({ title: 'text', content: 'text', tags: 'text' });
