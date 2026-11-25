import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { ApiKey, ApiKeyDocument } from './schemas/api-key.schema';
import type { ScopeMode } from '../common/permissions';
import { AuditLogService } from '../audit-log/audit-log.service';
import { RequestContext } from '../common/request-context';

interface ScopeFields {
  permissions?: string[];
  projectScopeMode?: ScopeMode;
  allowedProjectIds?: string[];
  customerScopeMode?: ScopeMode;
  allowedCustomerIds?: string[];
}

/**
 * Was `buildScopePatch` schreibt: dieselben Felder wie `ScopeFields`, aber mit
 * den ids bereits zu `ObjectId` konvertiert.
 *
 * Vorher war der Rückgabetyp `Record<string, unknown>`, weshalb die
 * Allowlist-Prüfung `patch.allowedProjectIds` per `as Types.ObjectId[]`
 * zurückbehaupten musste. Mit dem präzisen Typ ist die Prüfung derselbe
 * Vergleich — nur ohne Behauptung.
 */
interface ScopePatch {
  permissions?: string[];
  projectScopeMode?: ScopeMode;
  allowedProjectIds?: Types.ObjectId[];
  customerScopeMode?: ScopeMode;
  allowedCustomerIds?: Types.ObjectId[];
}

/** Not expired at `now` (keys without `expiresAt` never expire). */
function notExpired(now: Date) {
  return { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };
}

/** An OAuth connection that grants access: revoked, pending or expired ones do not. */
function liveOAuthConnection(now: Date) {
  return { kind: 'oauth', active: true, oauthPending: { $ne: true }, ...notExpired(now) };
}

/** Eine `$lookup`-angereicherte API-Key-Zeile aus der Aggregation. */
type ApiKeyRowWithOwner = Record<string, unknown> & { ownerUsername?: string };

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    @InjectModel(ApiKey.name) private apiKeyModel: Model<ApiKeyDocument>,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Key management (create/update/revoke) requires a user session (JWT).
   *
   * Without this a narrowed API key could escalate itself: create a fresh key
   * with the default all/all scope and no tool allowlist (effective scope =
   * the owner's full scope, admin role included), widen itself via update
   * (`projectScopeMode: 'all'`, `allowedTools: null`), or revoke the owner's
   * other keys. API-key actors carry `apiKeyId` (see `actorFromApiKey`).
   * No actor = trusted internal caller, passes.
   */
  private assertUserSession(action: string): void {
    const actor = RequestContext.getUser();
    if (actor?.apiKeyId) {
      throw new ForbiddenException(`${action} requires a user login; API keys cannot manage API keys`);
    }
  }

  private hashKey(plainKey: string): string {
    return createHash('sha256').update(plainKey).digest('hex');
  }

  private toObjectIds(ids: string[] | undefined, label: string): Types.ObjectId[] {
    if (!ids) return [];
    return ids.map((id) => {
      if (!Types.ObjectId.isValid(id)) {
        throw new BadRequestException(`Invalid ${label}: ${id}`);
      }
      return new Types.ObjectId(id);
    });
  }

  private buildScopePatch(scope: ScopeFields, isCreate: boolean): ScopePatch {
    const patch: ScopePatch = {};

    if (scope.permissions !== undefined) {
      patch.permissions = scope.permissions;
    } else if (isCreate) {
      patch.permissions = [];
    }

    if (scope.projectScopeMode !== undefined) {
      patch.projectScopeMode = scope.projectScopeMode;
    } else if (isCreate) {
      patch.projectScopeMode = 'all';
    }
    if (scope.allowedProjectIds !== undefined) {
      patch.allowedProjectIds = this.toObjectIds(scope.allowedProjectIds, 'projectId');
    } else if (isCreate) {
      patch.allowedProjectIds = [];
    }

    if (scope.customerScopeMode !== undefined) {
      patch.customerScopeMode = scope.customerScopeMode;
    } else if (isCreate) {
      patch.customerScopeMode = 'all';
    }
    if (scope.allowedCustomerIds !== undefined) {
      patch.allowedCustomerIds = this.toObjectIds(scope.allowedCustomerIds, 'customerId');
    } else if (isCreate) {
      patch.allowedCustomerIds = [];
    }

    // Sanity: if allowlist mode is set, the corresponding id list must not be
    // empty — otherwise the key would be silently locked out of all data on
    // that axis. We surface this as a validation error rather than letting it
    // drift through and confuse users.
    if (patch.projectScopeMode === 'allowlist') {
      const ids = patch.allowedProjectIds ?? [];
      if (ids.length === 0) {
        throw new BadRequestException(
          'projectScopeMode=allowlist erfordert mindestens eine projectId in allowedProjectIds.',
        );
      }
    }
    if (patch.customerScopeMode === 'allowlist') {
      const ids = patch.allowedCustomerIds ?? [];
      if (ids.length === 0) {
        throw new BadRequestException(
          'customerScopeMode=allowlist erfordert mindestens eine customerId in allowedCustomerIds.',
        );
      }
    }

    return patch;
  }

  async generate(
    userId: string,
    name: string,
    expiresAt?: Date,
    scope?: ScopeFields & { allowedTools?: string[] },
  ): Promise<{ key: string; apiKey: ApiKeyDocument }> {
    this.assertUserSession('Creating an API key');
    const raw = randomBytes(32).toString('hex');
    const plainKey = `cv_${raw}`;
    const keyHash = this.hashKey(plainKey);
    const prefix = plainKey.slice(0, 10) + '...';

    const scopePatch = this.buildScopePatch(scope ?? {}, true);

    const apiKey = await this.apiKeyModel.create({
      keyHash,
      prefix,
      name,
      userId,
      expiresAt,
      ...(scope?.allowedTools !== undefined ? { allowedTools: scope.allowedTools } : {}),
      ...scopePatch,
    });

    await this.auditLog.record({
      action: 'apikey.created',
      entityType: 'apikey',
      entityId: apiKey._id.toString(),
      meta: {
        name,
        ownerUserId: userId,
        expiresAt,
        scope: {
          permissions: scope?.permissions ?? [],
          projectScopeMode: scope?.projectScopeMode ?? 'all',
          allowedProjectIds: scope?.allowedProjectIds ?? [],
          customerScopeMode: scope?.customerScopeMode ?? 'all',
          allowedCustomerIds: scope?.allowedCustomerIds ?? [],
          allowedTools: scope?.allowedTools,
        },
      },
    });

    return { key: plainKey, apiKey };
  }

  /**
   * Creates the hidden API key behind an approved MCP OAuth connection.
   *
   * The key carries the connection's scope so the existing permission path
   * (`actorFromApiKey`, narrowed by the owner's own scope) applies unchanged
   * to OAuth requests. It has no usable secret: `keyHash` is the hash of a
   * random value that is discarded right here.
   *
   * Scope per axis: ids omitted = 'all' (the user's own rights), ids given =
   * 'allowlist', an empty list = 'none' (fail closed, never "everything").
   *
   * The connection starts out pending (`oauthPending`, short `expiresAt`):
   * `OAuthService` activates it when the first code is redeemed.
   *
   * Requires a user session like every other key mutation — a narrowed API
   * key must not mint itself an unrestricted connection.
   */
  async createOAuthConnection(input: {
    userId: string;
    clientId: string;
    clientName: string;
    /** Provisional expiry; extended when the first code is redeemed. */
    expiresAt: Date;
    projectIds?: string[];
    customerIds?: string[];
  }): Promise<ApiKeyDocument> {
    this.assertUserSession('Creating an OAuth connection');
    if (!Types.ObjectId.isValid(input.userId)) {
      throw new BadRequestException(`Invalid userId: ${input.userId}`);
    }
    const axis = (ids: string[] | undefined, label: string): { mode: ScopeMode; ids: Types.ObjectId[] } => {
      if (ids === undefined) return { mode: 'all', ids: [] };
      const oids = this.toObjectIds(ids, label);
      return oids.length ? { mode: 'allowlist', ids: oids } : { mode: 'none', ids: [] };
    };
    const projects = axis(input.projectIds, 'projectId');
    const customers = axis(input.customerIds, 'customerId');

    const discarded = randomBytes(32).toString('hex');
    return this.apiKeyModel.create({
      keyHash: this.hashKey(`oauth_${discarded}`),
      prefix: 'oauth',
      name: `OAuth: ${input.clientName}`,
      userId: new Types.ObjectId(input.userId),
      expiresAt: input.expiresAt,
      kind: 'oauth',
      oauthClientId: input.clientId,
      oauthClientName: input.clientName,
      oauthPending: true,
      permissions: [],
      projectScopeMode: projects.mode,
      allowedProjectIds: projects.ids,
      customerScopeMode: customers.mode,
      allowedCustomerIds: customers.ids,
    });
  }

  /**
   * Whether `plainKey` is the key behind `apiKey` (constant-time hash compare,
   * no DB access). Used by MCP `/messages` to make sure a request that presents
   * a key presents the SAME key its SSE session was opened with.
   */
  isSameKey(plainKey: string, apiKey: { keyHash?: string }): boolean {
    if (!apiKey.keyHash) return false;
    const a = Buffer.from(this.hashKey(plainKey), 'hex');
    const b = Buffer.from(apiKey.keyHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async validate(plainKey: string): Promise<ApiKeyDocument | null> {
    const keyHash = this.hashKey(plainKey);
    // OAuth connections are never valid as `cv_` keys (their hash belongs to
    // a discarded value anyway; this keeps it that way by construction).
    const apiKey = await this.apiKeyModel
      .findOne({ keyHash, active: true, kind: { $ne: 'oauth' } })
      .exec();
    if (!apiKey) return null;

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      return null;
    }

    await this.apiKeyModel.updateOne(
      { _id: apiKey._id },
      { $set: { lastUsedAt: new Date() } },
    ).exec();

    return apiKey;
  }

  /**
   * Aktiver, nicht abgelaufener Key per Id — für Workflow-Läufe, die ein Key
   * ausgelöst oder freigegeben hat und die später ohne Request laufen.
   * Anders als `validate` ohne `lastUsedAt`-Update: das ist keine Benutzung
   * durch den Key-Inhaber. Widerrufen heißt gelöscht → `null`.
   */
  async findActiveById(id: string): Promise<ApiKeyDocument | null> {
    // Nur geprüfte Ids in den Filter (Projektregel).
    if (!Types.ObjectId.isValid(id)) return null;
    const apiKey = await this.apiKeyModel.findOne({ _id: new Types.ObjectId(id), active: true }).exec();
    if (!apiKey) return null;
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;
    return apiKey;
  }

  /** The user's own API keys. OAuth connections are listed under "Connected apps". */
  async list(userId: string): Promise<ApiKeyDocument[]> {
    return this.apiKeyModel
      .find({ userId, kind: { $ne: 'oauth' } })
      .select('-keyHash')
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * T-337: admin-only "all keys" view. Augments each row with the owner's
   * username via $lookup so the Settings UI can render an Owner column
   * without N+1 calls.
   */
  async findAllWithOwners(): Promise<ApiKeyRowWithOwner[]> {
    // `aggregate()` ohne Typparameter liefert `any[]`; die Zeilen wanderten
    // damit untypisiert bis in den Controller. Der Parameter ändert nichts an
    // der Pipeline, macht aber die deklarierte Rückgabe zur geprüften Aussage.
    const rows = await this.apiKeyModel.aggregate<ApiKeyRowWithOwner>([
      // OAuth connections are listed (marked via `kind`) only while they
      // grant access: revoked and not yet redeemed ones are left out.
      { $match: { $or: [{ kind: { $ne: 'oauth' } }, liveOAuthConnection(new Date())] } },
      ...this.ownerLookupStages(),
    ]).exec();
    return rows;
  }

  /** Sort, owner username, `kind` default for legacy rows, no `keyHash`. */
  private ownerLookupStages(): PipelineStage[] {
    return [
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'owner',
          pipeline: [{ $project: { username: 1 } }],
        },
      },
      {
        $addFields: {
          ownerUsername: { $arrayElemAt: ['$owner.username', 0] },
          kind: { $ifNull: ['$kind', 'standard'] },
        },
      },
      { $project: { keyHash: 0, owner: 0 } },
    ];
  }

  /**
   * T-337: reverse lookup — which API keys can access the given project?
   * Match `projectScopeMode === 'all'` (broad) OR allowedProjectIds includes
   * the id (narrow allowlist). Includes owner usernames; OAuth connections
   * are marked by `kind: 'oauth'` and `oauthClientName`.
   */
  async findByProjectAccess(
    projectId: string,
  ): Promise<ApiKeyRowWithOwner[]> {
    if (!Types.ObjectId.isValid(projectId)) {
      throw new BadRequestException(`Invalid projectId: ${projectId}`);
    }
    const pid = new Types.ObjectId(projectId);
    const rows = await this.apiKeyModel.aggregate<ApiKeyRowWithOwner>([
      {
        $match: {
          // Only keys that can be used right now count as access: active,
          // not expired, and no OAuth connection still waiting for its code.
          active: true,
          oauthPending: { $ne: true },
          $and: [
            { $or: [{ projectScopeMode: 'all' }, { allowedProjectIds: pid }] },
            notExpired(new Date()),
          ],
        },
      },
      ...this.ownerLookupStages(),
    ]).exec();
    return rows;
  }

  async update(
    id: string,
    userId: string,
    updateData: { name?: string; allowedTools?: string[] | null } & ScopeFields,
  ): Promise<ApiKeyDocument> {
    this.assertUserSession('Updating an API key');
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException(`API Key ${id} not found`);
    await this.refuseOAuthConnection(id, userId, 'edited');
    const patch: Record<string, unknown> = {};
    const unset: Record<string, unknown> = {};

    if (updateData.name !== undefined) patch.name = updateData.name;

    // allowedTools handling:
    //   null  → unset (all tools allowed, default)
    //   []    → set empty array (explicitly no tools)
    //   [...] → set whitelist
    //   undefined → leave unchanged
    if (updateData.allowedTools === null) {
      unset.allowedTools = '';
    } else if (Array.isArray(updateData.allowedTools)) {
      patch.allowedTools = updateData.allowedTools;
    }

    Object.assign(patch, this.buildScopePatch(updateData, false));

    const ops: Record<string, unknown> = {};
    if (Object.keys(patch).length) ops.$set = patch;
    if (Object.keys(unset).length) ops.$unset = unset;

    const apiKey = await this.apiKeyModel
      .findOneAndUpdate({ _id: id, userId, kind: { $ne: 'oauth' } }, ops, { new: true })
      .select('-keyHash')
      .exec();
    if (!apiKey) throw new NotFoundException(`API Key ${id} not found`);

    // Persistent audit trail (T-214 — replaces previous Logger.warn placeholder).
    const securityFields = [
      'allowedTools', 'permissions',
      'projectScopeMode', 'allowedProjectIds',
      'customerScopeMode', 'allowedCustomerIds',
    ];
    const securityChanges: Record<string, unknown> = {};
    for (const f of securityFields) {
      if (f in patch) securityChanges[f] = (patch)[f];
      if (f in unset) securityChanges[`${f}_unset`] = true;
    }
    if (Object.keys(securityChanges).length > 0) {
      await this.auditLog.record({
        action: 'apikey.scope_changed',
        entityType: 'apikey',
        entityId: id,
        meta: { ownerUserId: userId, changes: securityChanges },
      });
    }

    return apiKey;
  }

  /**
   * OAuth connections are not managed through the API-key routes: their
   * scope is fixed at consent, and revoking must go through `OAuthService`
   * (tokens deleted, event emitted, open MCP sessions closed). Deleting the
   * key here would skip all of that.
   */
  private async refuseOAuthConnection(id: string, userId: string, verb: 'edited' | 'revoked'): Promise<void> {
    const key = await this.apiKeyModel
      .findOne({ _id: new Types.ObjectId(id), userId, kind: 'oauth' })
      .select('_id')
      .lean()
      .exec();
    if (key) {
      throw new BadRequestException(
        `OAuth connections cannot be ${verb} here; use "Connected apps" (DELETE /api/oauth/connections/:id)`,
      );
    }
  }

  async revoke(keyId: string, userId: string): Promise<void> {
    this.assertUserSession('Revoking an API key');
    if (!Types.ObjectId.isValid(keyId)) throw new NotFoundException(`API Key ${keyId} not found`);
    await this.refuseOAuthConnection(keyId, userId, 'revoked');
    const result = await this.apiKeyModel.findOneAndDelete({
      _id: keyId,
      userId,
      kind: { $ne: 'oauth' },
    }).exec();
    if (!result) throw new NotFoundException(`API Key ${keyId} not found`);
    await this.auditLog.record({
      action: 'apikey.revoked',
      entityType: 'apikey',
      entityId: keyId,
      meta: { ownerUserId: userId, name: result.name, prefix: result.prefix },
    });
  }
}
