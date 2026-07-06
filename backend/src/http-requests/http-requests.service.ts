import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import { RequestCollection, RequestCollectionDocument } from './schemas/request-collection.schema';
import {
  SavedRequest, SavedRequestDocument,
  HttpRequestMethod, RequestAuthType, RequestBodyMode,
} from './schemas/saved-request.schema';
import { RequestHistoryEntry, RequestHistoryDocument } from './schemas/request-history.schema';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { CreateRequestDto } from './dto/create-request.dto';
import { UpdateRequestDto } from './dto/update-request.dto';
import { SecretsService } from '../secrets/secrets.service';
import { EnvironmentsService } from '../environments/environments.service';
import { projectIdFilter } from '../common/project-id-filter';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { parseCurl } from './curl-parser';
import { ParsedCurlRequest } from './http-requests.types';

@Injectable()
export class HttpRequestsService {
  protected readonly logger = new Logger(HttpRequestsService.name);

  constructor(
    @InjectModel(RequestCollection.name) protected readonly collectionModel: Model<RequestCollectionDocument>,
    @InjectModel(SavedRequest.name) protected readonly requestModel: Model<SavedRequestDocument>,
    @InjectModel(RequestHistoryEntry.name) protected readonly historyModel: Model<RequestHistoryDocument>,
    protected readonly secretsService: SecretsService,
    protected readonly environmentsService: EnvironmentsService,
  ) {}

  protected objectId(id: string, label = 'id'): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException(`Invalid ${label}`);
    return new Types.ObjectId(id);
  }

  // ---- Collections --------------------------------------------------------
  async createCollection(dto: CreateCollectionDto): Promise<RequestCollectionDocument> {
    if (!dto.projectId) throw new BadRequestException('projectId is required');
    return this.collectionModel.create({
      projectId: this.objectId(dto.projectId, 'projectId'),
      name: dto.name,
      description: dto.description,
      order: dto.order ?? 0,
    });
  }

  async listCollections(projectId: string): Promise<RequestCollectionDocument[]> {
    return this.collectionModel
      .find({ projectId: projectIdFilter(projectId) })
      .sort({ order: 1, name: 1 })
      .exec();
  }

  async updateCollection(id: string, dto: UpdateCollectionDto): Promise<RequestCollectionDocument> {
    const doc = await this.collectionModel.findByIdAndUpdate(this.objectId(id), { $set: dto }, { new: true }).exec();
    if (!doc) throw new NotFoundException('Collection not found');
    return doc;
  }

  async deleteCollection(id: string): Promise<void> {
    const oid = this.objectId(id);
    const col = await this.collectionModel.findByIdAndDelete(oid).exec();
    if (!col) throw new NotFoundException('Collection not found');
    const reqIds = await this.requestModel.find({ collectionId: oid }).distinct('_id').exec();
    if (reqIds.length) {
      await this.historyModel.deleteMany({ requestId: { $in: reqIds } }).exec();
      await this.requestModel.deleteMany({ _id: { $in: reqIds } }).exec();
    }
  }

  // ---- Requests -----------------------------------------------------------
  async createRequest(dto: CreateRequestDto): Promise<SavedRequestDocument> {
    if (!dto.collectionId) throw new BadRequestException('collectionId is required');
    const col = await this.collectionModel.findById(this.objectId(dto.collectionId, 'collectionId')).exec();
    if (!col) throw new NotFoundException('Collection not found');
    return this.requestModel.create({
      projectId: col.projectId,
      collectionId: col._id,
      name: dto.name,
      description: dto.description,
      order: dto.order ?? 0,
      method: dto.method ?? HttpRequestMethod.GET,
      url: dto.url,
      queryParams: dto.queryParams ?? [],
      headers: dto.headers ?? [],
      auth: dto.auth ?? { type: RequestAuthType.NONE },
      body: dto.body ?? { mode: RequestBodyMode.NONE },
      timeoutMs: dto.timeoutMs ?? 30000,
      followRedirects: dto.followRedirects ?? false,
    });
  }

  async listRequests(filter: { collectionId?: string; projectId?: string }): Promise<SavedRequestDocument[]> {
    const q: Record<string, unknown> = {};
    if (filter.collectionId) q.collectionId = this.objectId(filter.collectionId, 'collectionId');
    if (filter.projectId) q.projectId = projectIdFilter(filter.projectId);
    if (!q.collectionId && !q.projectId) throw new BadRequestException('collectionId or projectId is required');
    return this.requestModel.find(q).sort({ order: 1, name: 1 }).exec();
  }

  async getRequest(id: string): Promise<SavedRequestDocument> {
    const doc = await this.requestModel.findById(this.objectId(id)).exec();
    if (!doc) throw new NotFoundException('Request not found');
    return doc;
  }

  async updateRequest(id: string, dto: UpdateRequestDto): Promise<SavedRequestDocument> {
    const $set: Record<string, unknown> = {};
    for (const key of ['name', 'description', 'order', 'method', 'url', 'queryParams', 'headers', 'auth', 'body', 'timeoutMs', 'followRedirects'] as const) {
      if ((dto as Record<string, unknown>)[key] !== undefined) $set[key] = (dto as Record<string, unknown>)[key];
    }
    const doc = await this.requestModel.findByIdAndUpdate(this.objectId(id), { $set }, { new: true }).exec();
    if (!doc) throw new NotFoundException('Request not found');
    return doc;
  }

  async deleteRequest(id: string): Promise<void> {
    const oid = this.objectId(id);
    const doc = await this.requestModel.findByIdAndDelete(oid).exec();
    if (!doc) throw new NotFoundException('Request not found');
    await this.historyModel.deleteMany({ requestId: oid }).exec();
  }

  // ---- History ------------------------------------------------------------
  async listHistory(requestId: string, limit = 50, offset = 0): Promise<RequestHistoryDocument[]> {
    return this.historyModel
      .find({ requestId: this.objectId(requestId, 'requestId') })
      .sort({ sentAt: -1 })
      .skip(Math.max(0, offset))
      .limit(Math.max(1, Math.min(limit, 500)))
      .exec();
  }

  async getHistoryEntry(id: string): Promise<RequestHistoryDocument> {
    const doc = await this.historyModel.findById(this.objectId(id)).exec();
    if (!doc) throw new NotFoundException('History entry not found');
    return doc;
  }

  // ---- curl import --------------------------------------------------------
  parseCurl(curl: string): ParsedCurlRequest {
    return parseCurl(curl);
  }

  async importCurl(collectionId: string, curl: string, name?: string): Promise<SavedRequestDocument> {
    const parsed = parseCurl(curl);
    return this.createRequest({
      collectionId,
      name: name || `${parsed.method} ${parsed.url}`.slice(0, 120),
      method: parsed.method as unknown as CreateRequestDto['method'],
      url: parsed.url,
      queryParams: parsed.queryParams,
      headers: parsed.headers,
      auth: parsed.auth as unknown as CreateRequestDto['auth'],
      body: parsed.body as unknown as CreateRequestDto['body'],
      followRedirects: parsed.followRedirects,
    });
  }

  // ---- Cascade cleanup ----------------------------------------------------
  @OnEvent(PROJECT_CHANGED)
  async handleCascade(event: ProjectChangeEvent): Promise<void> {
    if (event.action !== 'deleted' || event.entity !== 'project' || !event.entityId) return;
    if (!Types.ObjectId.isValid(event.entityId)) return;
    const pid = projectIdFilter(event.entityId);
    const reqIds = await this.requestModel.find({ projectId: pid }).distinct('_id').exec();
    if (reqIds.length) await this.historyModel.deleteMany({ requestId: { $in: reqIds } }).exec();
    await this.requestModel.deleteMany({ projectId: pid }).exec();
    await this.collectionModel.deleteMany({ projectId: pid }).exec();
  }
}
