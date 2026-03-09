import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SettingDocument = HydratedDocument<Setting>;

@Schema({ timestamps: true })
export class Setting {
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true })
  value: string;
}

export const SettingSchema = SchemaFactory.createForClass(Setting);
