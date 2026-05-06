import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export class EnvVariable {
  key: string;
  value: string;
}

export type EnvironmentDocument = HydratedDocument<Environment>;

@Schema({ timestamps: true })
export class Environment {
  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

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
EnvironmentSchema.index(
  { projectId: 1, name: 1 },
  { unique: true, partialFilterExpression: { projectId: { $exists: true } } },
);
EnvironmentSchema.index(
  { customerId: 1, name: 1 },
  { unique: true, partialFilterExpression: { customerId: { $exists: true } } },
);
