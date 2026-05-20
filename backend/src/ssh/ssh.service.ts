import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  SshConnection,
  SshConnectionDocument,
} from './schemas/ssh-connection.schema';
import {
  Secret,
  SecretDocument,
} from '../secrets/schemas/secret.schema';
import { SecretsService } from '../secrets/secrets.service';
import { CreateSshConnectionDto } from './dto/create-ssh-connection.dto';
import { UpdateSshConnectionDto } from './dto/update-ssh-connection.dto';

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
    private readonly secretsService: SecretsService,
  ) {}

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
   * this as a credential rotation: create new owned secrets, swap the refs,
   * then cascade-delete the previously owned credentials.
   */
  async update(id: string, dto: UpdateSshConnectionDto): Promise<SshConnectionDocument> {
    const doc = await this.findById(id);

    // Metadata patch.
    if (dto.label !== undefined) doc.label = dto.label;
    if (dto.host !== undefined) doc.host = dto.host;
    if (dto.port !== undefined) doc.port = dto.port;
    if (dto.username !== undefined) doc.username = dto.username;
    if (dto.description !== undefined) doc.description = dto.description;
    if (dto.tags !== undefined) doc.tags = dto.tags;
    if (dto.notifyOnAuthFailure !== undefined) {
      doc.notifyOnAuthFailure = dto.notifyOnAuthFailure;
    }

    // Credential rotation path.
    if (dto.inlineSecrets) {
      const oldRefs: Types.ObjectId[] = [];
      if (doc.privateKeySecretId) oldRefs.push(doc.privateKeySecretId);
      if (doc.passphraseSecretId) oldRefs.push(doc.passphraseSecretId);
      if (doc.passwordSecretId) oldRefs.push(doc.passwordSecretId);

      const newCreated: CreatedOwnedSecretRef[] = [];
      const scope = {
        customerId: doc.customerId?.toString(),
        projectId: doc.projectId?.toString(),
      };

      try {
        if (doc.authMethod === 'key' && dto.inlineSecrets.key) {
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
        } else if (doc.authMethod === 'password' && dto.inlineSecrets.password) {
          const pwRef = await this.createOwnedSecret({
            scope,
            key: `ssh:${doc.slug}:password`,
            value: dto.inlineSecrets.password.password,
            type: 'password',
            description: `SSH password for ${doc.label}`,
          });
          newCreated.push({ id: pwRef, field: 'passwordSecretId' });
          doc.passwordSecretId = pwRef;
        } else {
          throw new BadRequestException(
            `inlineSecrets does not match authMethod=${doc.authMethod}`,
          );
        }

        await doc.save();

        // Stamp ownedBy on freshly created secrets.
        await this.secretModel
          .updateMany(
            { _id: { $in: newCreated.map((s) => s.id) } },
            { $set: { ownedBySshConnectionId: doc._id } },
          )
          .exec();

        // Cascade-delete the previously owned (NOT pick-existing) credentials.
        if (oldRefs.length > 0) {
          await this.secretModel
            .deleteMany({
              _id: { $in: oldRefs },
              ownedBySshConnectionId: doc._id,
            })
            .exec();
        }
      } catch (err) {
        if (newCreated.length > 0) {
          await this.rollbackCreatedSecrets(newCreated).catch((cleanupErr) => {
            this.logger.error(
              `Failed to roll back ${newCreated.length} secret(s) after credential rotation error: ${
                (cleanupErr as Error).message
              }`,
            );
          });
        }
        throw err;
      }
      return doc;
    }

    await doc.save();
    return doc;
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
  }

  async setKnownHostFingerprint(id: string, fingerprint: string): Promise<SshConnectionDocument> {
    const doc = await this.findById(id);
    doc.knownHostFingerprint = fingerprint;
    await doc.save();
    return doc;
  }

  async recordConnectError(id: string, message: string): Promise<SshConnectionDocument> {
    const doc = await this.findById(id);
    doc.lastConnectError = { at: new Date(), message };
    await doc.save();
    return doc;
  }

  async recordConnectSuccess(id: string): Promise<SshConnectionDocument> {
    const doc = await this.findById(id);
    doc.lastConnectedAt = new Date();
    doc.lastConnectError = undefined;
    await doc.save();
    return doc;
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
