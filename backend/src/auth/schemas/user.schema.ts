import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

export enum UserRole {
  ADMIN = 'admin',
  USER = 'user',
}

export enum LlmMode {
  SERVER = 'server',
  BROWSER = 'browser',
}

export interface UserLlmConfig {
  mode?: LlmMode;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  fallbackEnabled?: boolean;
}

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true })
  username: string;

  @Prop({ unique: true, sparse: true })
  email: string;

  @Prop({ required: true })
  passwordHash: string;

  @Prop({ enum: UserRole, default: UserRole.USER })
  role: UserRole;

  @Prop({ default: true })
  active: boolean;

  @Prop({
    type: {
      mode: { type: String, enum: Object.values(LlmMode), default: LlmMode.SERVER },
      endpoint: { type: String, default: '' },
      model: { type: String, default: '' },
      apiKey: { type: String, default: '' },
      fallbackEnabled: { type: Boolean, default: false },
    },
    default: () => ({}),
    _id: false,
  })
  llmConfig: UserLlmConfig;
}

export const UserSchema = SchemaFactory.createForClass(User);
