import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, FilterQuery } from 'mongoose';
import { LogEntry, LogEntryDocument } from './schemas/log-entry.schema';
import { CreateLogDto } from './dto/create-log.dto';
import { RequestContext } from '../common/request-context';
import { actorCanAccessProject } from '../common/permissions';

const LOG_TTL_DAYS = parseInt(process.env.LOG_TTL_DAYS || '5', 10);

@Injectable()
export class LogsService {
  constructor(
    @InjectModel(LogEntry.name) private logModel: Model<LogEntryDocument>,
  ) {}

  async create(dto: CreateLogDto): Promise<LogEntryDocument> {
    const expiresAt = new Date(Date.now() + LOG_TTL_DAYS * 24 * 60 * 60 * 1000);
    return this.logModel.create({
      ...dto,
      projectId: new Types.ObjectId(dto.projectId),
      expiresAt,
    });
  }

  async createBatch(dtos: CreateLogDto[]): Promise<number> {
    const expiresAt = new Date(Date.now() + LOG_TTL_DAYS * 24 * 60 * 60 * 1000);
    const docs = dtos.map((dto) => ({
      ...dto,
      projectId: new Types.ObjectId(dto.projectId),
      expiresAt,
    }));
    const result = await this.logModel.insertMany(docs, { ordered: false });
    return result.length;
  }

  async findByProject(
    projectId: string,
    options?: {
      level?: string;
      service?: string;
      search?: string;
      startDate?: string;
      endDate?: string;
      limit?: number;
      offset?: number;
    },
  ) {
    const filter: FilterQuery<LogEntry> = { projectId: new Types.ObjectId(projectId) };

    if (options?.level) filter.level = options.level;
    if (options?.service) filter.service = options.service;
    if (options?.search) {
      filter.$text = { $search: options.search };
    }
    if (options?.startDate || options?.endDate) {
      filter.createdAt = {};
      if (options?.startDate) filter.createdAt.$gte = new Date(options.startDate);
      if (options?.endDate) filter.createdAt.$lte = new Date(options.endDate);
    }

    const limit = options?.limit || 50;
    const offset = options?.offset || 0;

    return this.logModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean()
      .exec();
  }

  /**
   * T-338: global cross-project view. When `projectIds` is set, restrict
   * to that allowlist. Always applies a per-row visibility filter via the
   * actor in RequestContext, so a narrow-scope API key can't widen its
   * view by dropping the projectId param.
   */
  async findGlobal(options?: {
    projectIds?: string[];
    level?: string;
    service?: string;
    search?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }) {
    const filter: FilterQuery<LogEntry> = {};

    if (options?.projectIds && options.projectIds.length > 0) {
      filter.projectId = { $in: options.projectIds.map((id) => new Types.ObjectId(id)) };
    }
    if (options?.level) filter.level = options.level;
    if (options?.service) filter.service = options.service;
    if (options?.search) filter.$text = { $search: options.search };
    if (options?.startDate || options?.endDate) {
      filter.createdAt = {};
      if (options?.startDate) filter.createdAt.$gte = new Date(options.startDate);
      if (options?.endDate) filter.createdAt.$lte = new Date(options.endDate);
    }

    const limit = options?.limit || 50;
    const offset = options?.offset || 0;

    // Oversample so the post-filter result still reaches `limit` when the
    // actor can only see a subset of projects.
    const actor = RequestContext.getUser();
    const oversample = Math.min(limit * 3, 500);
    const candidates = await this.logModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(oversample)
      .lean()
      .exec();

    const visible: LogEntryDocument[] = [];
    for (const doc of candidates) {
      if (actorCanAccessProject(actor, String(doc.projectId))) {
        visible.push(doc as unknown as LogEntryDocument);
      }
      if (visible.length >= limit) break;
    }
    return visible;
  }

  async stats(projectId: string): Promise<{
    total: number;
    byLevel: Record<string, number>;
    byService: { service: string; count: number }[];
    oldestEntry: Date | null;
    newestEntry: Date | null;
  }> {
    const pid = new Types.ObjectId(projectId);

    const [total, byLevel, byService, oldest, newest] = await Promise.all([
      this.logModel.countDocuments({ projectId: pid }),
      this.logModel.aggregate([
        { $match: { projectId: pid } },
        { $group: { _id: '$level', count: { $sum: 1 } } },
      ]),
      this.logModel.aggregate([
        { $match: { projectId: pid, service: { $ne: null } } },
        { $group: { _id: '$service', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ]),
      this.logModel.findOne({ projectId: pid }).sort({ createdAt: 1 }).select('createdAt').lean() as any,
      this.logModel.findOne({ projectId: pid }).sort({ createdAt: -1 }).select('createdAt').lean() as any,
    ]);

    const levelMap: Record<string, number> = {};
    for (const item of byLevel) {
      levelMap[item._id] = item.count;
    }

    return {
      total,
      byLevel: levelMap,
      byService: byService.map((s) => ({ service: s._id, count: s.count })),
      oldestEntry: oldest?.createdAt || null,
      newestEntry: newest?.createdAt || null,
    };
  }

  async deleteByProject(projectId: string): Promise<number> {
    const result = await this.logModel.deleteMany({ projectId: new Types.ObjectId(projectId) });
    return result.deletedCount;
  }
}
