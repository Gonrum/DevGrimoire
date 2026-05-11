import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CustomerTemplateDocument = CustomerTemplate & Document;

export enum CustomerTemplateType {
  ONBOARDING = 'onboarding',
  TODO_LIST = 'todo_list',
  MONITORING = 'monitoring',
  ENVIRONMENT = 'environment',
  WORKFLOW = 'workflow',
  CONTACT_TYPE = 'contact_type',
}

export enum CustomerTemplateItemKind {
  TODO = 'todo',
  MONITORING_CHECK = 'monitoring_check',
  ENVIRONMENT = 'environment',
  WORKFLOW = 'workflow',
  CONTACT_TYPE = 'contact_type',
  NOTE = 'note',
}

@Schema({ _id: false })
export class CustomerTemplateItem {
  @Prop({ required: true, enum: CustomerTemplateItemKind })
  kind: CustomerTemplateItemKind;

  @Prop({ required: true })
  title: string;

  @Prop()
  description?: string;

  @Prop({ type: Object, default: {} })
  payload: Record<string, unknown>;

  @Prop({ type: [String], default: [] })
  requiredSecretKeys: string[];

  @Prop({ type: Object, default: {} })
  placeholders: Record<string, string>;
}

export const CustomerTemplateItemSchema = SchemaFactory.createForClass(CustomerTemplateItem);

@Schema({ timestamps: true })
export class CustomerTemplate {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, index: true })
  slug: string;

  @Prop()
  description?: string;

  @Prop({ required: true, enum: CustomerTemplateType, index: true })
  type: CustomerTemplateType;

  @Prop({ default: true, index: true })
  active: boolean;

  @Prop({ default: 1, min: 1 })
  version: number;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: [CustomerTemplateItemSchema], default: [] })
  items: CustomerTemplateItem[];

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdByUserId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedByUserId?: Types.ObjectId;

  createdAt?: Date;
  updatedAt?: Date;
}

export const CustomerTemplateSchema = SchemaFactory.createForClass(CustomerTemplate);

CustomerTemplateSchema.index({ type: 1, active: 1, updatedAt: -1 });
CustomerTemplateSchema.index({ slug: 1 }, { unique: true });
CustomerTemplateSchema.index({ tags: 1 });
