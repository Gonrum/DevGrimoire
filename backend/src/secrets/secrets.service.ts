import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FilterQuery, Model } from 'mongoose';
import { Secret, SecretDocument } from './schemas/secret.schema';
import { CreateSecretDto } from './dto/create-secret.dto';
import { UpdateSecretDto } from './dto/update-secret.dto';
import { CustomersService } from '../customers/customers.service';
import { EncryptionService } from '../common/encryption.service';
import { PROJECT_CHANGED } from '../events/project-event';
import { RequestContext } from '../common/request-context';
import {
  actorCanAccessCustomer,
  actorCanAccessProject,
} from '../common/permissions';

export interface SecretListItem {
  _id: string;
  projectId: string | null;
  customerId: string | null;
  environmentId: string | null;
  key: string;
  description?: string;
  type: string;
  // Optional, weil `timestamps: true` die Felder erst beim Schreiben anlegt:
  // am Typ sind sie damit `Date | undefined`. Vorher stand hier `Date` und
  // `toListItem` musste den Wert per `as any` aus dem Dokument holen.
  createdAt?: Date;
  updatedAt?: Date;
}

@Injectable()
export class SecretsService {
  constructor(
    @InjectModel(Secret.name) private secretModel: Model<SecretDocument>,
    private customersService: CustomersService,
    private encryptionService: EncryptionService,
    private eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateSecretDto): Promise<SecretListItem> {
    if (!this.encryptionService.isEnabled()) {
      throw new BadRequestException('Secrets encryption not configured: set SECRETS_ENCRYPTION_KEY');
    }
    if (!dto.projectId && !dto.customerId) {
      throw new BadRequestException('projectId or customerId is required');
    }
    if (dto.projectId && dto.customerId) {
      throw new BadRequestException('projectId and customerId are mutually exclusive');
    }
    if (dto.customerId) {
      await this.customersService.findById(dto.customerId);
    }

    const encryptedValue = this.encryptionService.encrypt(dto.value);
    const ownerFilter = dto.projectId
      ? { projectId: dto.projectId }
      : { customerId: dto.customerId };

    const secret = await this.secretModel.findOneAndUpdate(
      { ...ownerFilter, environmentId: dto.environmentId || null, key: dto.key },
      {
        $set: {
          encryptedValue,
          description: dto.description,
          type: dto.type || 'variable',
          ...ownerFilter,
          environmentId: dto.environmentId || null,
          key: dto.key,
        },
      },
      { new: true, upsert: true },
    ).exec();

    return this.toListItem(secret);
  }

  async findByProject(projectId: string, environmentId?: string): Promise<SecretListItem[]> {
    const actor = RequestContext.getUser();
    if (actor && !actorCanAccessProject(actor, projectId)) {
      throw new ForbiddenException(`Project ${projectId} is not in your scope`);
    }
    // `FilterQuery` statt `any`: der Filter bleibt Feld für Feld derselbe.
    // Wichtig ist die `!== undefined`-Bedingung — sie bleibt unverändert, denn
    // Mongoose *entfernt* `undefined`-Felder aus dem Filter, ein
    // `environmentId: undefined` würde also nicht "kein Environment" heißen,
    // sondern "beliebiges Environment".
    const filter: FilterQuery<SecretDocument> = { projectId };
    if (environmentId !== undefined) {
      filter.environmentId = environmentId || null;
    }
    const secrets = await this.secretModel.find(filter).sort({ key: 1 }).exec();
    return secrets.map((s) => this.toListItem(s));
  }

  async findByCustomer(customerId: string, environmentId?: string): Promise<SecretListItem[]> {
    const actor = RequestContext.getUser();
    if (actor && !actorCanAccessCustomer(actor, customerId)) {
      throw new ForbiddenException(`Customer ${customerId} is not in your scope`);
    }
    const filter: FilterQuery<SecretDocument> = { customerId };
    if (environmentId !== undefined) {
      filter.environmentId = environmentId || null;
    }
    const secrets = await this.secretModel.find(filter).sort({ key: 1 }).exec();
    return secrets.map((s) => this.toListItem(s));
  }

  async findById(id: string): Promise<SecretListItem & { value: string }> {
    const secret = await this.secretModel.findById(id).exec();
    if (!secret) throw new NotFoundException('Secret not found');

    const actor = RequestContext.getUser();
    if (actor) {
      const projectId = secret.projectId?.toString() || null;
      const customerId = secret.customerId?.toString() || null;
      const projectOk = !projectId || actorCanAccessProject(actor, projectId);
      const customerOk = !customerId || actorCanAccessCustomer(actor, customerId);
      if (!projectOk || !customerOk) {
        throw new ForbiddenException(`Secret ${id} is not in your scope`);
      }
    }

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
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: result.projectId?.toString() || null,
      customerId: result.customerId?.toString() || null,
      entity: 'secret',
      action: 'deleted',
      entityId: result._id.toString(),
      summary: `Siegel "${result.key}" gelöscht`,
    });
  }

  async removeByProject(projectId: string): Promise<void> {
    await this.secretModel.deleteMany({ projectId }).exec();
  }

  async removeByCustomer(customerId: string): Promise<void> {
    await this.secretModel.deleteMany({ customerId }).exec();
  }

  async getDecryptedForEnvironment(
    owner: { projectId?: string; customerId?: string },
    environmentId?: string,
  ): Promise<{ key: string; value: string }[]> {
    // Ohne Owner wäre der Filter leer und diese Methode gäbe **alle Secrets der
    // Datenbank entschlüsselt** zurück. Heute prüfen beide Aufrufer den Owner
    // vorher, der Pfad ist also unerreichbar — aber genau diese Klasse (leerer
    // Filter trifft alles) hat in diesem Projekt schon dreimal echte Fehler
    // verursacht, weil Mongoose `undefined`-Felder aus dem Filter entfernt.
    // Bei einem Entschlüsselungspfad ist das die Absicherung wert.
    if (!owner.projectId && !owner.customerId) {
      throw new BadRequestException('projectId or customerId is required');
    }

    const filter: FilterQuery<SecretDocument> = {};
    if (owner.projectId) filter.projectId = owner.projectId;
    if (owner.customerId) filter.customerId = owner.customerId;
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
      projectId: obj.projectId ? obj.projectId.toString() : null,
      customerId: obj.customerId ? obj.customerId.toString() : null,
      environmentId: obj.environmentId,
      key: obj.key,
      description: obj.description,
      type: obj.type || 'variable',
      createdAt: obj.createdAt,
      updatedAt: obj.updatedAt,
    };
  }
}
