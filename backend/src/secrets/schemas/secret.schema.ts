import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SecretDocument = HydratedDocument<Secret>;

@Schema({ timestamps: true })
export class Secret {
  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  @Prop({ type: String, default: null })
  environmentId: string | null;

  @Prop({ required: true })
  key: string;

  @Prop({ required: true })
  encryptedValue: string;

  @Prop()
  description: string;

  @Prop({ type: String, default: 'variable' })
  type: string;
}

export const SecretSchema = SchemaFactory.createForClass(Secret);
SecretSchema.index(
  { projectId: 1, environmentId: 1, key: 1 },
  { unique: true, partialFilterExpression: { projectId: { $exists: true } } },
);
SecretSchema.index(
  { customerId: 1, environmentId: 1, key: 1 },
  { unique: true, partialFilterExpression: { customerId: { $exists: true } } },
);
