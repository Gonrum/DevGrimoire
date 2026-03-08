import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export class EnvVariable {
  key: string;
  value: string;
}

export type EnvironmentDocument = HydratedDocument<Environment>;

@Schema({ timestamps: true })
export class Environment {
  @Prop({ required: true })
  projectId: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  description: string;

  @Prop()
  host: string;

  @Prop({ type: Number })
  port: number;

  @Prop()
  user: string;

  @Prop()
  url: string;

  @Prop({ type: [{ key: String, value: String }], default: [] })
  variables: EnvVariable[];

  @Prop({ default: true })
  active: boolean;
}

export const EnvironmentSchema = SchemaFactory.createForClass(Environment);
EnvironmentSchema.index({ projectId: 1, name: 1 }, { unique: true });
