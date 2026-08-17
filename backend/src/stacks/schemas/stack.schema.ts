import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ _id: true })
export class StackEntry {
  @Prop({ required: true })
  title: string;

  @Prop({ default: '' })
  content: string;

  @Prop({ required: true })
  order: number;
}
export const StackEntrySchema = SchemaFactory.createForClass(StackEntry);

@Schema({ timestamps: true })
export class Stack {
  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop({ type: [StackEntrySchema], default: [] })
  entries: StackEntry[];

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type StackDocument = HydratedDocument<Stack>;
export const StackSchema = SchemaFactory.createForClass(Stack);
