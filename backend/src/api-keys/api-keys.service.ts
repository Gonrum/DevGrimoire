import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomBytes, createHash } from 'crypto';
import { ApiKey, ApiKeyDocument } from './schemas/api-key.schema';

@Injectable()
export class ApiKeysService {
  constructor(
    @InjectModel(ApiKey.name) private apiKeyModel: Model<ApiKeyDocument>,
  ) {}

  private hashKey(plainKey: string): string {
    return createHash('sha256').update(plainKey).digest('hex');
  }

  async generate(
    userId: string,
    name: string,
    expiresAt?: Date,
  ): Promise<{ key: string; apiKey: ApiKeyDocument }> {
    const raw = randomBytes(32).toString('hex');
    const plainKey = `cv_${raw}`;
    const keyHash = this.hashKey(plainKey);
    const prefix = plainKey.slice(0, 10) + '...';

    const apiKey = await this.apiKeyModel.create({
      keyHash,
      prefix,
      name,
      userId,
      expiresAt,
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
    updateData: { name?: string; allowedTools?: string[] | null },
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

    const ops: Record<string, unknown> = {};
    if (Object.keys(patch).length) ops.$set = patch;
    if (Object.keys(unset).length) ops.$unset = unset;

    const apiKey = await this.apiKeyModel
      .findOneAndUpdate({ _id: id, userId }, ops, { new: true })
      .select('-keyHash')
      .exec();
    if (!apiKey) throw new NotFoundException(`API Key ${id} not found`);
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
