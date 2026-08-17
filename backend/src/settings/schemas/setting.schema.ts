import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SettingDocument = HydratedDocument<Setting>;

@Schema({ timestamps: true })
export class Setting {
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true })
  value: string;

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const SettingSchema = SchemaFactory.createForClass(Setting);
