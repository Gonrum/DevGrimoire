import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  SshConnection,
  SshConnectionDocument,
} from './schemas/ssh-connection.schema';
import {
  SshAudit,
  SshAuditDocument,
} from './schemas/ssh-audit.schema';
import {
  Secret,
  SecretDocument,
} from '../secrets/schemas/secret.schema';
import { SecretsService } from '../secrets/secrets.service';
import { CreateSshConnectionDto } from './dto/create-ssh-connection.dto';
import { UpdateSshConnectionDto } from './dto/update-ssh-connection.dto';
import { PROJECT_CHANGED } from '../events/project-event';

interface CreatedOwnedSecretRef {
  id: Types.ObjectId;
  field: 'privateKeySecretId' | 'passphraseSecretId' | 'passwordSecretId';
}

@Injectable()
export class SshService {
  private readonly logger = new Logger(SshService.name);

  constructor(
    @InjectModel(SshConnection.name)
    private readonly sshModel: Model<SshConnectionDocument>,
    @InjectModel(Secret.name)
    private readonly secretModel: Model<SecretDocument>,
    @InjectModel(SshAudit.name)
    private readonly auditModel: Model<SshAuditDocument>,
    private readonly secretsService: SecretsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Emit a `PROJECT_CHANGED` event for an SSH connection mutation. Routes
   * through the EventEmitter so the WS-Multiplex bus picks it up immediately
   * (the Change-Stream watcher would also fire, but that has higher latency
   * and skips customer-scoped docs by default until M-38's dual-scope rules
   * kick in).
   *
   * `summary` is consumed by clients that want a quick label without
   * re-fetching the doc (currently informational only).
   */
  private emitConnectionChange(
    doc: SshConnectionDocument,
    action: 'created' | 'updated' | 'deleted',
    summary?: string,
  ): void {
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: doc.projectId?.toString() || null,
      customerId: doc.customerId?.toString() || null,
      entity: 'ssh-connection',
      action,
      entityId: (doc._id as Types.ObjectId).toString(),
      summary,
    });
  }

  // -------------------------------------------------------------------------
  // Public CRUD
  // -------------------------------------------------------------------------

  /**
   * Atomic create. Mirrors spec §5.4 "Submit-Flow (Create)":
   *   (a) validate DTO invariants
   *   (b) create inline secrets (if any) — no owner yet
   *   (c) create SshConnection referencing them
   *   (d) stamp `ownedBySshConnectionId` on those secrets
   * On any failure after (b) the freshly created secrets are rolled back so
   * no orphans remain.
   *
   * `userId` is reserved for future scope-check / audit integration. Kept in
   * the signature because the spec mandates it and downstream PRs (audit
   * writes) will need it without breaking callers.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async create(dto: CreateSshConnectionDto, userId: string): Promise<SshConnectionDocument> {
    this.validateScope(dto.customerId, dto.projectId);
    this.validateAuthInputs(dto);

    // (b) Create inline secrets, collect rollback refs.
    const createdSecrets: CreatedOwnedSecretRef[] = [];
    const refs: {
      privateKeySecretId?: Types.ObjectId;
      passphraseSecretId?: Types.ObjectId;
      passwordSecretId?: Types.ObjectId;
    } = {};

    try {
      if (dto.authMethod === 'key') {
        if (dto.inlineSecrets?.key) {
          const pkRef = await this.createOwnedSecret({
            scope: { customerId: dto.customerId, projectId: dto.projectId },
            key: `ssh:${dto.slug}:privatekey`,
            value: dto.inlineSecrets.key.privateKey,
            type: 'ssh_key',
            description: `SSH private key for ${dto.label}`,
          });
          refs.privateKeySecretId = pkRef;
          createdSecrets.push({ id: pkRef, field: 'privateKeySecretId' });

          if (dto.inlineSecrets.key.passphrase) {
            const ppRef = await this.createOwnedSecret({
              scope: { customerId: dto.customerId, projectId: dto.projectId },
              key: `ssh:${dto.slug}:passphrase`,
              value: dto.inlineSecrets.key.passphrase,
              type: 'password',
              description: `SSH key passphrase for ${dto.label}`,
            });
            refs.passphraseSecretId = ppRef;
            createdSecrets.push({ id: ppRef, field: 'passphraseSecretId' });
          }
        } else {
          refs.privateKeySecretId = this.toObjectId(
            dto.privateKeySecretId!,
            'privateKeySecretId',
          );
          if (dto.passphraseSecretId) {
            refs.passphraseSecretId = this.toObjectId(
              dto.passphraseSecretId,
              'passphraseSecretId',
            );
          }
        }
      } else {
        // authMethod === 'password'
        if (dto.inlineSecrets?.password) {
          const pwRef = await this.createOwnedSecret({
            scope: { customerId: dto.customerId, projectId: dto.projectId },
            key: `ssh:${dto.slug}:password`,
            value: dto.inlineSecrets.password.password,
            type: 'password',
            description: `SSH password for ${dto.label}`,
          });
          refs.passwordSecretId = pwRef;
          createdSecrets.push({ id: pwRef, field: 'passwordSecretId' });
        } else {
          refs.passwordSecretId = this.toObjectId(
            dto.passwordSecretId!,
            'passwordSecretId',
          );
        }
      }

      // (c) Create SshConnection.
      const created = await this.sshModel.create({
        label: dto.label,
        slug: dto.slug,
        customerId: dto.customerId ? this.toObjectId(dto.customerId, 'customerId') : undefined,
        projectId: dto.projectId ? this.toObjectId(dto.projectId, 'projectId') : undefined,
        host: dto.host,
        port: dto.port ?? 22,
        username: dto.username,
        authMethod: dto.authMethod,
        privateKeySecretId: refs.privateKeySecretId,
        passphraseSecretId: refs.passphraseSecretId,
        passwordSecretId: refs.passwordSecretId,
        description: dto.description,
        tags: dto.tags ?? [],
        notifyOnAuthFailure: dto.notifyOnAuthFailure ?? false,
      });

      // (d) Stamp ownedBy on freshly created secrets.
      if (createdSecrets.length > 0) {
        await this.secretModel
          .updateMany(
            { _id: { $in: createdSecrets.map((s) => s.id) } },
            { $set: { ownedBySshConnectionId: created._id } },
          )
          .exec();
      }

      this.emitConnectionChange(created, 'created', `SSH-Verbindung "${created.label}" angelegt`);
      return created;
    } catch (err) {
      // Rollback any secrets we created in this transaction.
      if (createdSecrets.length > 0) {
        await this.rollbackCreatedSecrets(createdSecrets).catch((cleanupErr) => {
          this.logger.error(
            `Failed to roll back ${createdSecrets.length} secret(s) after SshConnection create error: ${
              (cleanupErr as Error).message
            }`,
          );
        });
      }
      // Translate duplicate-key error into the conventional 409.
      if (this.isDuplicateKeyError(err)) {
        throw new ConflictException(
          `SshConnection slug "${dto.slug}" already exists in this scope`,
        );
      }
      throw err;
    }
  }

  async findById(id: string): Promise<SshConnectionDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('SshConnection not found');
    }
    const doc = await this.sshModel.findById(id).exec();
    if (!doc) throw new NotFoundException('SshConnection not found');
    return doc;
  }

  async findByCustomerId(customerId: string): Promise<SshConnectionDocument[]> {
    return this.sshModel
      .find({ customerId: this.toObjectId(customerId, 'customerId') })
      .sort({ label: 1 })
      .exec();
  }

  async findByProjectId(projectId: string): Promise<SshConnectionDocument[]> {
    return this.sshModel
      .find({ projectId: this.toObjectId(projectId, 'projectId') })
      .sort({ label: 1 })
      .exec();
  }

  /**
   * Patch metadata only by default. If `inlineSecrets` is provided, we treat
   * this as a credential rotation: cascade-delete the previously owned
   * credentials FIRST (otherwise the new owned secret would collide on the
   * partial unique index `(projectId|customerId, environmentId, key)`),
   * THEN create the new owned secrets, then atomically swap the refs.
   *
   * The atomic swap uses optimistic-concurrency-control via Mongoose's `__v`
   * version key: we read the doc, mutate refs in memory, then conditionally
   * write back only if `__v` is still the one we read. Concurrent writers
   * lose with `ConflictException`, and we roll back any new secrets we just
   * created so the loser doesn't leak orphans.
   */
  async update(id: string, dto: UpdateSshConnectionDto): Promise<SshConnectionDocument> {
    const doc = await this.findById(id);
    const expectedVersion = (doc as unknown as { __v?: number }).__v ?? 0;

    // Snapshot the original credential refs so we can restore them on the
    // in-memory `doc` if the conditional write fails (Important #4).
    const origRefs = {
      privateKeySecretId: doc.privateKeySecretId,
      passphraseSecretId: doc.passphraseSecretId,
      passwordSecretId: doc.passwordSecretId,
    };

    // Metadata patch (in-memory only — actually persisted further down via
    // findOneAndUpdate so we get the version-guard).
    const metaPatch: Record<string, unknown> = {};
    if (dto.label !== undefined) {
      doc.label = dto.label;
      metaPatch.label = dto.label;
    }
    if (dto.slug !== undefined && dto.slug !== doc.slug) {
      doc.slug = dto.slug;
      metaPatch.slug = dto.slug;
    }
    if (dto.host !== undefined) {
      doc.host = dto.host;
      metaPatch.host = dto.host;
    }
    if (dto.port !== undefined) {
      doc.port = dto.port;
      metaPatch.port = dto.port;
    }
    if (dto.username !== undefined) {
      doc.username = dto.username;
      metaPatch.username = dto.username;
    }
    if (dto.description !== undefined) {
      doc.description = dto.description;
      metaPatch.description = dto.description;
    }
    if (dto.tags !== undefined) {
      doc.tags = dto.tags;
      metaPatch.tags = dto.tags;
    }
    if (dto.notifyOnAuthFailure !== undefined) {
      doc.notifyOnAuthFailure = dto.notifyOnAuthFailure;
      metaPatch.notifyOnAuthFailure = dto.notifyOnAuthFailure;
    }

    // Did the caller supply pick-existing rotation refs?
    const hasPickRotation =
      dto.privateKeySecretId !== undefined ||
      dto.passwordSecretId !== undefined;

    // Auth-method effective for this update — may switch atomically with a
    // credential rotation. Pure metadata patches keep the existing method.
    const effectiveAuthMethod = dto.authMethod ?? doc.authMethod;
    const isRotation = !!dto.inlineSecrets || hasPickRotation;
    if (isRotation && dto.authMethod && dto.authMethod !== doc.authMethod) {
      doc.authMethod = dto.authMethod;
      metaPatch.authMethod = dto.authMethod;
    }

    // Credential rotation path — inline.
    if (dto.inlineSecrets) {
      const oldOwnedIds: Types.ObjectId[] = [];
      if (origRefs.privateKeySecretId) oldOwnedIds.push(origRefs.privateKeySecretId);
      if (origRefs.passphraseSecretId) oldOwnedIds.push(origRefs.passphraseSecretId);
      if (origRefs.passwordSecretId) oldOwnedIds.push(origRefs.passwordSecretId);

      const newCreated: CreatedOwnedSecretRef[] = [];
      const scope = {
        customerId: doc.customerId?.toString(),
        projectId: doc.projectId?.toString(),
      };

      // Delete-first-then-create: critical for not violating the unique
      // partial index on `(scope, environmentId, key)`. We only delete
      // secrets that are actually owned by THIS connection — pick-existing
      // refs (no ownedBy stamp) survive.
      let deletedOwnedIds: Types.ObjectId[] = [];
      if (oldOwnedIds.length > 0) {
        const ownedDocs = await this.secretModel
          .find({
            _id: { $in: oldOwnedIds },
            ownedBySshConnectionId: doc._id,
          })
          .exec();
        deletedOwnedIds = ownedDocs.map((s) => s._id as Types.ObjectId);
        if (deletedOwnedIds.length > 0) {
          await this.secretModel
            .deleteMany({ _id: { $in: deletedOwnedIds } })
            .exec();
        }
      }

      try {
        if (effectiveAuthMethod === 'key' && dto.inlineSecrets.key) {
          const pkRef = await this.createOwnedSecret({
            scope,
            key: `ssh:${doc.slug}:privatekey`,
            value: dto.inlineSecrets.key.privateKey,
            type: 'ssh_key',
            description: `SSH private key for ${doc.label}`,
          });
          newCreated.push({ id: pkRef, field: 'privateKeySecretId' });
          doc.privateKeySecretId = pkRef;

          if (dto.inlineSecrets.key.passphrase) {
            const ppRef = await this.createOwnedSecret({
              scope,
              key: `ssh:${doc.slug}:passphrase`,
              value: dto.inlineSecrets.key.passphrase,
              type: 'password',
              description: `SSH key passphrase for ${doc.label}`,
            });
            newCreated.push({ id: ppRef, field: 'passphraseSecretId' });
            doc.passphraseSecretId = ppRef;
          } else {
            doc.passphraseSecretId = undefined;
          }
          // Clear the opposite-method ref if we just switched auth method.
          doc.passwordSecretId = undefined;
        } else if (effectiveAuthMethod === 'password' && dto.inlineSecrets.password) {
          const pwRef = await this.createOwnedSecret({
            scope,
            key: `ssh:${doc.slug}:password`,
            value: dto.inlineSecrets.password.password,
            type: 'password',
            description: `SSH password for ${doc.label}`,
          });
          newCreated.push({ id: pwRef, field: 'passwordSecretId' });
          doc.passwordSecretId = pwRef;
          // Clear the opposite-method refs if we just switched auth method.
          doc.privateKeySecretId = undefined;
          doc.passphraseSecretId = undefined;
        } else {
          throw new BadRequestException(
            `inlineSecrets does not match authMethod=${effectiveAuthMethod}`,
          );
        }

        // Conditional write guarded by `__v`. If another writer raced in
        // between our findById() and now, `__v` has advanced and this
        // returns null → ConflictException + rollback.
        const updated = await this.sshModel
          .findOneAndUpdate(
            { _id: doc._id, __v: expectedVersion },
            {
              $set: {
                ...metaPatch,
                privateKeySecretId: doc.privateKeySecretId,
                passphraseSecretId: doc.passphraseSecretId,
                passwordSecretId: doc.passwordSecretId,
              },
              $inc: { __v: 1 },
            },
            { new: true },
          )
          .exec();
        if (!updated) {
          throw new ConflictException(
            'SshConnection was modified by another request; please retry',
          );
        }

        // Stamp ownedBy on freshly created secrets.
        if (newCreated.length > 0) {
          await this.secretModel
            .updateMany(
              { _id: { $in: newCreated.map((s) => s.id) } },
              { $set: { ownedBySshConnectionId: updated._id } },
            )
            .exec();
        }

        this.emitConnectionChange(updated, 'updated', `SSH-Verbindung "${updated.label}" rotiert`);
        return updated;
      } catch (err) {
        // Rollback new secrets we just created so we don't leak orphans.
        if (newCreated.length > 0) {
          await this.rollbackCreatedSecrets(newCreated).catch((cleanupErr) => {
            this.logger.error(
              `Failed to roll back ${newCreated.length} secret(s) after credential rotation error: ${
                (cleanupErr as Error).message
              }`,
            );
          });
        }
        // Restore the in-memory doc so a caller holding the reference sees
        // the pre-rotation state instead of half-mutated refs.
        doc.privateKeySecretId = origRefs.privateKeySecretId;
        doc.passphraseSecretId = origRefs.passphraseSecretId;
        doc.passwordSecretId = origRefs.passwordSecretId;
        throw err;
      }
    }

    // Credential rotation path — pick-existing. Drop previously-owned
    // secrets first (just like the inline path) so an existing owned secret
    // with a colliding key can be freed before we swap refs in.
    if (hasPickRotation) {
      const oldOwnedIds: Types.ObjectId[] = [];
      if (origRefs.privateKeySecretId) oldOwnedIds.push(origRefs.privateKeySecretId);
      if (origRefs.passphraseSecretId) oldOwnedIds.push(origRefs.passphraseSecretId);
      if (origRefs.passwordSecretId) oldOwnedIds.push(origRefs.passwordSecretId);
      if (oldOwnedIds.length > 0) {
        const ownedDocs = await this.secretModel
          .find({
            _id: { $in: oldOwnedIds },
            ownedBySshConnectionId: doc._id,
          })
          .exec();
        const deletedIds = ownedDocs.map((s) => s._id as Types.ObjectId);
        if (deletedIds.length > 0) {
          await this.secretModel.deleteMany({ _id: { $in: deletedIds } }).exec();
        }
      }

      if (effectiveAuthMethod === 'key') {
        if (!dto.privateKeySecretId) {
          throw new BadRequestException(
            'privateKeySecretId is required for key-auth rotation',
          );
        }
        doc.privateKeySecretId = this.toObjectId(
          dto.privateKeySecretId,
          'privateKeySecretId',
        );
        doc.passphraseSecretId = dto.passphraseSecretId
          ? this.toObjectId(dto.passphraseSecretId, 'passphraseSecretId')
          : undefined;
        doc.passwordSecretId = undefined;
      } else {
        if (!dto.passwordSecretId) {
          throw new BadRequestException(
            'passwordSecretId is required for password-auth rotation',
          );
        }
        doc.passwordSecretId = this.toObjectId(
          dto.passwordSecretId,
          'passwordSecretId',
        );
        doc.privateKeySecretId = undefined;
        doc.passphraseSecretId = undefined;
      }

      const updated = await this.sshModel
        .findOneAndUpdate(
          { _id: doc._id, __v: expectedVersion },
          {
            $set: {
              ...metaPatch,
              privateKeySecretId: doc.privateKeySecretId,
              passphraseSecretId: doc.passphraseSecretId,
              passwordSecretId: doc.passwordSecretId,
            },
            $inc: { __v: 1 },
          },
          { new: true },
        )
        .exec();
      if (!updated) {
        throw new ConflictException(
          'SshConnection was modified by another request; please retry',
        );
      }
      this.emitConnectionChange(updated, 'updated', `SSH-Verbindung "${updated.label}" rotiert`);
      return updated;
    }

    // Pure-metadata path: still version-guarded.
    if (Object.keys(metaPatch).length === 0) {
      // Nothing to update.
      return doc;
    }
    const updated = await this.sshModel
      .findOneAndUpdate(
        { _id: doc._id, __v: expectedVersion },
        { $set: metaPatch, $inc: { __v: 1 } },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new ConflictException(
        'SshConnection was modified by another request; please retry',
      );
    }
    this.emitConnectionChange(updated, 'updated', `SSH-Verbindung "${updated.label}" aktualisiert`);
    return updated;
  }

  /**
   * Cascade-delete per spec §3.2: drop every Secret whose
   * `ownedBySshConnectionId === connection._id`, then the connection itself.
   * Pick-Existing secrets (no owner stamp) are left untouched.
   */
  async delete(id: string): Promise<void> {
    const doc = await this.findById(id);

    // Delete owned secrets first. We query by ownedBy rather than by the
    // connection's *current* refs, so we also clean up legacy owned secrets
    // that might be no-longer-referenced (e.g. an aborted rotation).
    await this.secretModel
      .deleteMany({ ownedBySshConnectionId: doc._id })
      .exec();

    await this.sshModel.deleteOne({ _id: doc._id }).exec();
    this.emitConnectionChange(doc, 'deleted', `SSH-Verbindung "${doc.label}" gelöscht`);
  }

  async setKnownHostFingerprint(id: string, fingerprint: string): Promise<SshConnectionDocument> {
    const doc = await this.findById(id);
    doc.knownHostFingerprint = fingerprint;
    await doc.save();
    // Status change (TOFU accept) → re-emit so the UI flips from
    // 🔒 fingerprint_pending to ✅ ok without a manual refresh.
    this.emitConnectionChange(doc, 'updated', `SSH-Fingerprint für "${doc.label}" akzeptiert`);
    return doc;
  }

  async recordConnectError(id: string, message: string): Promise<SshConnectionDocument> {
    const doc = await this.findById(id);
    doc.lastConnectError = { at: new Date(), message };
    await doc.save();
    // Status change (connect failure) → re-emit so the UI flips to ❌/⚠️.
    this.emitConnectionChange(doc, 'updated', `SSH-Connect-Fehler für "${doc.label}"`);
    return doc;
  }

  async recordConnectSuccess(id: string): Promise<SshConnectionDocument> {
    const doc = await this.findById(id);
    doc.lastConnectedAt = new Date();
    doc.lastConnectError = undefined;
    await doc.save();
    // Status change (connect success) → re-emit so the UI flips to ✅.
    this.emitConnectionChange(doc, 'updated', `SSH-Connect-Success für "${doc.label}"`);
    return doc;
  }

  /**
   * Find by `slug` within a scope (customerId OR projectId — exactly one).
   * Returns null when not found instead of throwing, so callers can map to
   * structured MCP error codes.
   */
  async findBySlug(
    slug: string,
    scope: { projectId?: string; customerId?: string },
  ): Promise<SshConnectionDocument | null> {
    const filter: Record<string, unknown> = { slug };
    if (scope.projectId) {
      if (!Types.ObjectId.isValid(scope.projectId)) return null;
      filter.projectId = new Types.ObjectId(scope.projectId);
    } else if (scope.customerId) {
      if (!Types.ObjectId.isValid(scope.customerId)) return null;
      filter.customerId = new Types.ObjectId(scope.customerId);
    } else {
      return null;
    }
    return this.sshModel.findOne(filter).exec();
  }

  /**
   * Look up the most recent SshAudit row for a connection. Used by MCP
   * `ssh_connection_get` to surface "what happened last" without exposing
   * the whole audit trail. Returns null when nothing has been recorded yet.
   */
  async findLatestAudit(connectionId: string): Promise<SshAuditDocument | null> {
    if (!Types.ObjectId.isValid(connectionId)) return null;
    return this.auditModel
      .findOne({ connectionId: new Types.ObjectId(connectionId) })
      .sort({ at: -1 })
      .exec();
  }

  /**
   * Filter connections by scope + tags (AND semantics: every tag in the
   * filter must be present on the connection). Used by MCP
   * `ssh_connection_list`. Scope is mandatory — callers must pass either
   * customerId or projectId.
   */
  async findByScopeAndTags(args: {
    projectId?: string;
    customerId?: string;
    tags?: string[];
  }): Promise<SshConnectionDocument[]> {
    const filter: Record<string, unknown> = {};
    if (args.projectId) {
      if (!Types.ObjectId.isValid(args.projectId)) return [];
      filter.projectId = new Types.ObjectId(args.projectId);
    } else if (args.customerId) {
      if (!Types.ObjectId.isValid(args.customerId)) return [];
      filter.customerId = new Types.ObjectId(args.customerId);
    } else {
      return [];
    }
    if (args.tags && args.tags.length > 0) {
      filter.tags = { $all: args.tags };
    }
    return this.sshModel.find(filter).sort({ label: 1 }).exec();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private validateScope(customerId?: string, projectId?: string): void {
    if (!customerId && !projectId) {
      throw new BadRequestException(
        'SshConnection requires exactly one of customerId or projectId',
      );
    }
    if (customerId && projectId) {
      throw new BadRequestException(
        'SshConnection cannot have both customerId and projectId',
      );
    }
  }

  /**
   * DTO-level auth sanity check before any DB work. Catches both
   * "key without privateKey source" and "password without password source"
   * before we go and create orphan secrets.
   */
  private validateAuthInputs(dto: CreateSshConnectionDto): void {
    if (dto.authMethod === 'key') {
      const hasInlineKey = !!dto.inlineSecrets?.key;
      const hasPickedKey = !!dto.privateKeySecretId;
      if (hasInlineKey === hasPickedKey) {
        throw new BadRequestException(
          'authMethod=key requires exactly one of inlineSecrets.key or privateKeySecretId',
        );
      }
      if (dto.passwordSecretId || dto.inlineSecrets?.password) {
        throw new BadRequestException(
          'authMethod=key must not provide password credentials',
        );
      }
      if (hasInlineKey && dto.passphraseSecretId) {
        throw new BadRequestException(
          'Provide passphrase either inline OR by passphraseSecretId, not both',
        );
      }
    } else if (dto.authMethod === 'password') {
      const hasInlinePw = !!dto.inlineSecrets?.password;
      const hasPickedPw = !!dto.passwordSecretId;
      if (hasInlinePw === hasPickedPw) {
        throw new BadRequestException(
          'authMethod=password requires exactly one of inlineSecrets.password or passwordSecretId',
        );
      }
      if (
        dto.privateKeySecretId ||
        dto.passphraseSecretId ||
        dto.inlineSecrets?.key
      ) {
        throw new BadRequestException(
          'authMethod=password must not provide key credentials',
        );
      }
    } else {
      throw new BadRequestException(
        `authMethod must be 'key' or 'password'`,
      );
    }
  }

  private async createOwnedSecret(args: {
    scope: { customerId?: string; projectId?: string };
    key: string;
    value: string;
    type: string;
    description: string;
  }): Promise<Types.ObjectId> {
    const created = await this.secretsService.create({
      projectId: args.scope.projectId,
      customerId: args.scope.customerId,
      key: args.key,
      value: args.value,
      type: args.type,
      description: args.description,
    });
    return new Types.ObjectId(created._id);
  }

  private async rollbackCreatedSecrets(refs: CreatedOwnedSecretRef[]): Promise<void> {
    await this.secretModel
      .deleteMany({ _id: { $in: refs.map((r) => r.id) } })
      .exec();
  }

  private toObjectId(id: string, label: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Invalid ${label}`);
    }
    return new Types.ObjectId(id);
  }

  private isDuplicateKeyError(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: number }).code === 11000
    );
  }
}
