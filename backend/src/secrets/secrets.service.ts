import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Secret, SecretDocument } from './schemas/secret.schema';
import { CreateSecretDto } from './dto/create-secret.dto';
import { UpdateSecretDto } from './dto/update-secret.dto';
import { EncryptionService } from '../common/encryption.service';

export interface SecretListItem {
  _id: string;
  projectId: string;
  environmentId: string | null;
  key: string;
  description?: string;
  type: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class SecretsService {
  constructor(
    @InjectModel(Secret.name) private secretModel: Model<SecretDocument>,
    private encryptionService: EncryptionService,
  ) {}

  async create(dto: CreateSecretDto): Promise<SecretListItem> {
    if (!this.encryptionService.isEnabled()) {
      throw new BadRequestException('Secrets encryption not configured: set SECRETS_ENCRYPTION_KEY');
    }

    const encryptedValue = this.encryptionService.encrypt(dto.value);

    const secret = await this.secretModel.findOneAndUpdate(
      { projectId: dto.projectId, environmentId: dto.environmentId || null, key: dto.key },
      {
        $set: {
          encryptedValue,
          description: dto.description,
          type: dto.type || 'variable',
          projectId: dto.projectId,
          environmentId: dto.environmentId || null,
          key: dto.key,
        },
      },
      { new: true, upsert: true },
    ).exec();

    return this.toListItem(secret!);
  }

  async findByProject(projectId: string, environmentId?: string): Promise<SecretListItem[]> {
    const filter: any = { projectId };
    if (environmentId !== undefined) {
      filter.environmentId = environmentId || null;
    }
    const secrets = await this.secretModel.find(filter).sort({ key: 1 }).exec();
    return secrets.map((s) => this.toListItem(s));
  }

  async findById(id: string): Promise<SecretListItem & { value: string }> {
    const secret = await this.secretModel.findById(id).exec();
    if (!secret) throw new NotFoundException('Secret not found');

    const value = this.encryptionService.decrypt(secret.encryptedValue);
    return { ...this.toListItem(secret), value };
  }

  async update(id: string, dto: UpdateSecretDto): Promise<SecretListItem> {
    const secret = await this.secretModel.findById(id).exec();
    if (!secret) throw new NotFoundException('Secret not found');

    if (dto.key !== undefined) secret.key = dto.key;
    if (dto.description !== undefined) secret.description = dto.description;
    if (dto.type !== undefined) secret.type = dto.type;
    if (dto.value !== undefined) {
      if (!this.encryptionService.isEnabled()) {
        throw new BadRequestException('Secrets encryption not configured');
      }
      secret.encryptedValue = this.encryptionService.encrypt(dto.value);
    }

    await secret.save();
    return this.toListItem(secret);
  }

  async delete(id: string): Promise<void> {
    const result = await this.secretModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException('Secret not found');
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.secretModel.deleteMany({ projectId }).exec();
  }

  async getDecryptedForEnvironment(projectId: string, environmentId?: string): Promise<{ key: string; value: string }[]> {
    const filter: any = { projectId };
    if (environmentId !== undefined) {
      filter.environmentId = environmentId || null;
    }
    const secrets = await this.secretModel.find(filter).sort({ key: 1 }).exec();
    return secrets.map((s) => ({
      key: s.key,
      value: this.encryptionService.decrypt(s.encryptedValue),
    }));
  }

  private toListItem(secret: SecretDocument): SecretListItem {
    const obj = secret.toObject();
    return {
      _id: obj._id.toString(),
      projectId: obj.projectId,
      environmentId: obj.environmentId,
      key: obj.key,
      description: obj.description,
      type: obj.type || 'variable',
      createdAt: (obj as any).createdAt,
      updatedAt: (obj as any).updatedAt,
    };
  }
}
