import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type CounterDocument = HydratedDocument<Counter>;

@Schema()
export class Counter {
  @Prop({ type: Types.ObjectId, ref: 'Project', required: true })
  projectId: Types.ObjectId;

  @Prop({ required: true, enum: ['todo', 'milestone'] })
  entity: string;

  @Prop({ default: 0 })
  seq: number;
}

export const CounterSchema = SchemaFactory.createForClass(Counter);
CounterSchema.index({ projectId: 1, entity: 1 }, { unique: true });
