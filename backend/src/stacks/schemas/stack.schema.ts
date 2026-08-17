import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

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

  // `Types.DocumentArray` statt `StackEntry[]`: das ist der Laufzeittyp, den
  // Mongoose für ein Subdokument-Array einsetzt, samt `.id()` und `.pull()`.
  // Mit `StackEntry[]` am Typ brauchte der Service ein
  // `as unknown as Types.DocumentArray<…>`, um an genau diese Methoden zu
  // kommen — eine Behauptung über etwas, was ohnehin zutrifft.
  @Prop({ type: [StackEntrySchema], default: [] })
  entries: Types.DocumentArray<StackEntry>;

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export type StackDocument = HydratedDocument<Stack>;
export const StackSchema = SchemaFactory.createForClass(Stack);
