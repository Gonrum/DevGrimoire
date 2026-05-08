import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes, createHash } from 'crypto';
import { ApiKey, ApiKeyDocument } from './schemas/api-key.schema';
import type { ScopeMode } from '../common/permissions';

interface ScopeFields {
  permissions?: string[];
  projectScopeMode?: ScopeMode;
  allowedProjectIds?: string[];
  customerScopeMode?: ScopeMode;
  allowedCustomerIds?: string[];
}

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    @InjectModel(ApiKey.name) private apiKeyModel: Model<ApiKeyDocument>,
  ) {}

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

  private buildScopePatch(scope: ScopeFields, isCreate: boolean): Record<string, unknown> {
    const patch: Record<string, unknown> = {};

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
      const ids = (patch.allowedProjectIds as Types.ObjectId[] | undefined) ?? [];
      if (ids.length === 0) {
        throw new BadRequestException(
          'projectScopeMode=allowlist erfordert mindestens eine projectId in allowedProjectIds.',
        );
      }
    }
    if (patch.customerScopeMode === 'allowlist') {
      const ids = (patch.allowedCustomerIds as Types.ObjectId[] | undefined) ?? [];
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

    return { key: plainKey, apiKey };
  }

  async validate(plainKey: string): Promise<ApiKeyDocument | null> {
    const keyHash = this.hashKey(plainKey);
    const apiKey = await this.apiKeyModel.findOne({ keyHash, active: true }).exec();
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

  async list(userId: string): Promise<ApiKeyDocument[]> {
    return this.apiKeyModel
      .find({ userId })
      .select('-keyHash')
      .sort({ createdAt: -1 })
      .exec();
  }

  async update(
    id: string,
    userId: string,
    updateData: { name?: string; allowedTools?: string[] | null } & ScopeFields,
  ): Promise<ApiKeyDocument> {
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
      .findOneAndUpdate({ _id: id, userId }, ops, { new: true })
      .select('-keyHash')
      .exec();
    if (!apiKey) throw new NotFoundException(`API Key ${id} not found`);

    // Lightweight audit-trail: log scope/permission changes until full
    // audit-log module (T-214) lands.
    const securityFields = [
      'allowedTools', 'permissions',
      'projectScopeMode', 'allowedProjectIds',
      'customerScopeMode', 'allowedCustomerIds',
    ];
    const securityChanges: Record<string, unknown> = {};
    for (const f of securityFields) {
      if (f in patch) securityChanges[f] = (patch as Record<string, unknown>)[f];
      if (f in unset) securityChanges[`${f}_unset`] = true;
    }
    if (Object.keys(securityChanges).length > 0) {
      this.logger.warn(
        `[security-audit] ApiKey ${id} (owner ${userId}) scope changed: ${JSON.stringify(securityChanges)}`,
      );
    }

    return apiKey;
  }

  async revoke(keyId: string, userId: string): Promise<void> {
    const result = await this.apiKeyModel.findOneAndDelete({
      _id: keyId,
      userId,
    }).exec();
    if (!result) throw new NotFoundException(`API Key ${keyId} not found`);
  }
}
