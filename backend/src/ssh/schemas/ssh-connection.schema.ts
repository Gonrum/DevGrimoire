import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SshAuthMethod = 'key' | 'password';

@Schema({ _id: false })
export class SshLastConnectError {
  @Prop({ required: true })
  at: Date;

  @Prop({ required: true })
  message: string;
}
export const SshLastConnectErrorSchema = SchemaFactory.createForClass(SshLastConnectError);

export type SshConnectionDocument = HydratedDocument<SshConnection>;

@Schema({ timestamps: true, collection: 'sshconnections' })
export class SshConnection {
  // ---- UI / Lookup ----------------------------------------------------------
  @Prop({ required: true, trim: true })
  label: string;

  // url-safe identifier, unique per scope (customer or project)
  @Prop({ required: true, trim: true })
  slug: string;

  // ---- Scope (exactly one of customerId / projectId; enforced in pre-save) --
  @Prop({ type: Types.ObjectId, ref: 'Customer' })
  customerId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId;

  // ---- Connection parameters -----------------------------------------------
  @Prop({ required: true, trim: true })
  host: string;

  @Prop({ required: true, default: 22, min: 1, max: 65535 })
  port: number;

  @Prop({ required: true, trim: true })
  username: string;

  @Prop({ required: true, type: String, enum: ['key', 'password'] })
  authMethod: SshAuthMethod;

  // ---- Credential references (FK -> Secret) --------------------------------
  // Only set in combinations consistent with authMethod (validated pre-save).
  @Prop({ type: Types.ObjectId, ref: 'Secret' })
  privateKeySecretId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Secret' })
  passphraseSecretId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Secret' })
  passwordSecretId?: Types.ObjectId;

  // ---- Metadata -------------------------------------------------------------
  @Prop()
  description?: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  // ---- TOFU host-key verification ------------------------------------------
  // SHA-256 fingerprint, set after explicit user accept (see /accept-fingerprint).
  @Prop()
  knownHostFingerprint?: string;

  // ---- Status tracking ------------------------------------------------------
  @Prop()
  lastConnectedAt?: Date;

  @Prop({ type: SshLastConnectErrorSchema })
  lastConnectError?: SshLastConnectError;

  // ---- Notification options -------------------------------------------------
  @Prop({ default: false })
  notifyOnAuthFailure: boolean;
}

export const SshConnectionSchema = SchemaFactory.createForClass(SshConnection);

// Unique slug per scope (partial filters keep null scopes from colliding).
SshConnectionSchema.index(
  { customerId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { customerId: { $exists: true } } },
);
SshConnectionSchema.index(
  { projectId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { projectId: { $exists: true } } },
);

// Listing indexes.
SshConnectionSchema.index(
  { customerId: 1 },
  { partialFilterExpression: { customerId: { $exists: true } } },
);
SshConnectionSchema.index(
  { projectId: 1 },
  { partialFilterExpression: { projectId: { $exists: true } } },
);

// Format constraints for slug (kebab-case, 3-60 chars, [a-z0-9-]).
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateSshConnectionInvariants(doc: {
  customerId?: unknown;
  projectId?: unknown;
  authMethod?: unknown;
  privateKeySecretId?: unknown;
  passphraseSecretId?: unknown;
  passwordSecretId?: unknown;
  slug?: unknown;
}): void {
  // ---- Scope: exactly one of customerId / projectId ----------------------
  const hasCustomer = !!doc.customerId;
  const hasProject = !!doc.projectId;
  if (hasCustomer === hasProject) {
    throw new Error(
      'SshConnection requires exactly one of customerId or projectId (got ' +
        (hasCustomer && hasProject ? 'both' : 'neither') +
        ')',
    );
  }

  // ---- Slug format -------------------------------------------------------
  const slug = typeof doc.slug === 'string' ? doc.slug : '';
  if (slug.length < 3 || slug.length > 60 || !SLUG_RE.test(slug)) {
    throw new Error(
      'SshConnection.slug must be kebab-case, 3-60 chars, [a-z0-9-]',
    );
  }

  // ---- Auth-method <-> credential consistency ----------------------------
  if (doc.authMethod === 'key') {
    if (!doc.privateKeySecretId) {
      throw new Error(
        'SshConnection with authMethod=key requires privateKeySecretId',
      );
    }
    if (doc.passwordSecretId) {
      throw new Error(
        'SshConnection with authMethod=key must not set passwordSecretId',
      );
    }
  } else if (doc.authMethod === 'password') {
    if (!doc.passwordSecretId) {
      throw new Error(
        'SshConnection with authMethod=password requires passwordSecretId',
      );
    }
    if (doc.privateKeySecretId || doc.passphraseSecretId) {
      throw new Error(
        'SshConnection with authMethod=password must not set privateKeySecretId / passphraseSecretId',
      );
    }
  } else {
    throw new Error(`SshConnection.authMethod must be 'key' or 'password'`);
  }
}

SshConnectionSchema.pre('save', function (next) {
  try {
    validateSshConnectionInvariants(this as unknown as Parameters<typeof validateSshConnectionInvariants>[0]);
    next();
  } catch (err) {
    next(err as Error);
  }
});

// Exported for service-level pre-flight validation (so we can reject before
// touching Secrets and avoid orphaned credentials).
export const __sshConnectionInvariantsForTests = validateSshConnectionInvariants;
export const SSH_SLUG_REGEX = SLUG_RE;
