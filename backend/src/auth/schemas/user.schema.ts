import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { ScopeMode } from '../../common/permissions';

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

  // Fine-grained permissions (T-210). See `common/permissions.ts` for the
  // catalog. Empty array on a non-admin user = legacy "no fine-grained perms"
  // mode (controllers fall back to role-based logic). Admins ignore this field.
  @Prop({ type: [String], default: [] })
  permissions: string[];

  // Project scope (T-221). Independent from customerScopeMode. Defaults give
  // existing users full access so the migration is a no-op for active accounts.
  @Prop({ type: String, enum: ['all', 'allowlist', 'none'], default: 'all' })
  projectScopeMode: ScopeMode;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Project' }], default: [] })
  allowedProjectIds: Types.ObjectId[];

  @Prop({ type: String, enum: ['all', 'allowlist', 'none'], default: 'all' })
  customerScopeMode: ScopeMode;

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Customer' }], default: [] })
  allowedCustomerIds: Types.ObjectId[];

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

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — ohne Deklaration brauchten Leser dafür ein `as any`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);
