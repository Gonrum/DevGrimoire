import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export enum CustomerProjectLinkStatus {
  ACTIVE = 'active',
  PAUSED = 'paused',
  ARCHIVED = 'archived',
}

export type CustomerProjectLinkDocument = HydratedDocument<CustomerProjectLink>;

@Schema({ timestamps: true })
export class CustomerProjectLink {
  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true, index: true })
  customerId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Project', required: true, index: true })
  projectId: Types.ObjectId;

  @Prop({ type: String, enum: CustomerProjectLinkStatus, default: CustomerProjectLinkStatus.ACTIVE })
  status: CustomerProjectLinkStatus;

  @Prop()
  role?: string;

  @Prop()
  notes?: string;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Environment' }], default: [] })
  environmentIds: Types.ObjectId[];
}

export const CustomerProjectLinkSchema = SchemaFactory.createForClass(CustomerProjectLink);
CustomerProjectLinkSchema.index({ customerId: 1, projectId: 1 }, { unique: true });
CustomerProjectLinkSchema.index({ projectId: 1, status: 1 });
