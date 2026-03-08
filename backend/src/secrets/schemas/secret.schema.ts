import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SecretDocument = HydratedDocument<Secret>;

@Schema({ timestamps: true })
export class Secret {
  @Prop({ required: true })
  projectId: string;

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
SecretSchema.index({ projectId: 1, environmentId: 1, key: 1 }, { unique: true });
