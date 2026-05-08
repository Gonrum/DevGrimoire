import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ALL_SENSITIVITY_LEVELS, Sensitivity, SensitivityLevel } from '../../common/sensitivity';

export type AttachmentDocument = HydratedDocument<Attachment>;

@Schema({ timestamps: true })
export class Attachment {
  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  @Prop({ type: String })
  entityType?: string;

  @Prop({ type: Types.ObjectId })
  entityId?: Types.ObjectId;

  @Prop({ required: true })
  originalName: string;

  @Prop({ required: true })
  mimeType: string;

  @Prop({ required: true })
  size: number;

  @Prop({ required: true })
  storageKey: string;

  @Prop({ type: String })
  description?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: String })
  textContent?: string;

  @Prop({ type: Boolean, default: false })
  ragIndexed: boolean;

  // Data classification (T-219). confidential/personal/secret skip RAG.
  @Prop({ type: String, enum: ALL_SENSITIVITY_LEVELS, default: Sensitivity.INTERNAL })
  sensitivity: SensitivityLevel;
}

export const AttachmentSchema = SchemaFactory.createForClass(Attachment);
AttachmentSchema.index({ projectId: 1 });
AttachmentSchema.index({ customerId: 1 });
AttachmentSchema.index({ projectId: 1, entityType: 1, entityId: 1 });
AttachmentSchema.index({ customerId: 1, entityType: 1, entityId: 1 });
AttachmentSchema.index(
  { originalName: 'text', description: 'text' },
  { name: 'attachment_text', language_override: 'lang' },
);
