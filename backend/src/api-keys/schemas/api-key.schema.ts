import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import type { ScopeMode } from '../../common/permissions';

export type ApiKeyDocument = HydratedDocument<ApiKey>;

@Schema({ timestamps: true })
export class ApiKey {
  @Prop({ required: true, unique: true })
  keyHash: string;

  @Prop({ required: true })
  prefix: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop()
  lastUsedAt: Date;

  @Prop()
  expiresAt: Date;

  @Prop({ default: true })
  active: boolean;

  // default: undefined — Mongoose would otherwise default arrays to [],
  // which would mean "no tools" for every new key. undefined = "all tools".
  @Prop({ type: [String], default: undefined })
  allowedTools?: string[];

  // Fine-grained permissions (T-210). Empty array = legacy default (rely on
  // owning user's role/permissions). See `common/permissions.ts` for catalog.
  @Prop({ type: [String], default: [] })
  permissions: string[];

  // Project-scope (T-220). 'all' = unrestricted, 'allowlist' = only ids in
  // allowedProjectIds, 'none' = no project access at all.
  @Prop({ type: String, enum: ['all', 'allowlist', 'none'], default: 'all' })
  projectScopeMode: ScopeMode;

  @Prop({ type: [{ type: SchemaTypes.ObjectId, ref: 'Project' }], default: [] })
  allowedProjectIds: Types.ObjectId[];

  // Customer-scope (T-220), independent from projectScopeMode.
  @Prop({ type: String, enum: ['all', 'allowlist', 'none'], default: 'all' })
  customerScopeMode: ScopeMode;

  @Prop({ type: [{ type: SchemaTypes.ObjectId, ref: 'Customer' }], default: [] })
  allowedCustomerIds: Types.ObjectId[];

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — ohne Deklaration brauchten Leser dafür ein `as any`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const ApiKeySchema = SchemaFactory.createForClass(ApiKey);
ApiKeySchema.index({ userId: 1 });
// Der Unique-Index auf `keyHash` entsteht schon über `@Prop({ unique: true })`;
// ein zweites `schema.index` erzeugte dieselbe Definition und eine
// Mongoose-Warnung bei jedem Laden des Schemas.
