import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, FilterQuery } from 'mongoose';
import { LogEntry, LogEntryDocument } from './schemas/log-entry.schema';
import { CreateLogDto } from './dto/create-log.dto';
import { RequestContext } from '../common/request-context';
import { actorCanAccessProject } from '../common/permissions';
import { assertProjectInScope } from '../common/scope-guard';

/**
 * Validate the projectId before it becomes an ObjectId in a filter and check
 * it against the actor's scope. Log entries include `workspace_terminal`
 * lines with full commands — a narrowed actor must neither read nor write
 * logs of foreign projects.
 */
function scopedProjectId(projectId: string | undefined): Types.ObjectId {
  if (!projectId || !Types.ObjectId.isValid(projectId)) {
    throw new BadRequestException(`Invalid projectId: ${String(projectId)}`);
  }
  assertProjectInScope(projectId);
  return new Types.ObjectId(projectId);
}

const LOG_TTL_DAYS = parseInt(process.env.LOG_TTL_DAYS || '5', 10);

/** Ergebnisform der `$group`-Pipelines in `stats()` — `_id` ist der Gruppenschlüssel. */
interface GroupCount {
  _id: string;
  count: number;
}

/**
 * Datums-Grenze aus einem Query-Parameter.
 *
 * `startDate`/`endDate` sind am DTO nur `@IsString()`, ein `?startDate=gestern`
 * ergab also `new Date('gestern')` → `Invalid Date`. Das lief unbemerkt in den
 * Mongo-Filter, wo Mongoose es mit einem CastError quittierte — HTTP 500 für
 * einen Eingabefehler. Hier wird daraus ein 400 mit Feldnamen.
 */
function dateBound(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} is not a valid date: ${value}`);
  }
  return parsed;
}

/**
 * Zeitfenster als eigenes, getyptes Objekt.
 *
 * `filter.createdAt` ist bei Mongoose ein `Condition<Date>` und damit effektiv
 * `any` — `filter.createdAt.$gte = …` war deshalb ein unsafe-member-access auf
 * `any`. Der Aufbau passiert hier getypt, erst das fertige Objekt geht in den
 * Filter.
 */
function createdAtRange(startDate?: string, endDate?: string): { $gte?: Date; $lte?: Date } {
  const range: { $gte?: Date; $lte?: Date } = {};
  if (startDate) range.$gte = dateBound(startDate, 'startDate');
  if (endDate) range.$lte = dateBound(endDate, 'endDate');
  return range;
}

@Injectable()
export class LogsService {
  constructor(
    @InjectModel(LogEntry.name) private logModel: Model<LogEntryDocument>,
  ) {}

  async create(dto: CreateLogDto): Promise<LogEntryDocument> {
    const expiresAt = new Date(Date.now() + LOG_TTL_DAYS * 24 * 60 * 60 * 1000);
    return this.logModel.create({
      ...dto,
      projectId: scopedProjectId(dto.projectId),
      expiresAt,
    });
  }

  async createBatch(dtos: CreateLogDto[]): Promise<number> {
    const expiresAt = new Date(Date.now() + LOG_TTL_DAYS * 24 * 60 * 60 * 1000);
    if (!Array.isArray(dtos)) throw new BadRequestException('logs must be an array');
    // Map (and thereby check) every entry before inserting anything, so one
    // foreign projectId rejects the whole batch.
    const docs = dtos.map((dto) => ({
      ...dto,
      projectId: scopedProjectId(dto.projectId),
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
    const filter: FilterQuery<LogEntry> = { projectId: scopedProjectId(projectId) };

    if (options?.level) filter.level = options.level;
    if (options?.service) filter.service = options.service;
    if (options?.search) {
      filter.$text = { $search: options.search };
    }
    if (options?.startDate || options?.endDate) {
      filter.createdAt = createdAtRange(options?.startDate, options?.endDate);
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
      for (const id of options.projectIds) {
        if (!Types.ObjectId.isValid(id)) throw new BadRequestException(`Invalid projectId: ${id}`);
      }
      filter.projectId = { $in: options.projectIds.map((id) => new Types.ObjectId(id)) };
    }
    if (options?.level) filter.level = options.level;
    if (options?.service) filter.service = options.service;
    if (options?.search) filter.$text = { $search: options.search };
    if (options?.startDate || options?.endDate) {
      filter.createdAt = createdAtRange(options?.startDate, options?.endDate);
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

    // Die Kandidaten sind `lean()`-Objekte, keine hydrierten Dokumente. Vorher
    // stand hier `LogEntryDocument[]` und je Zeile ein `as unknown as` — die
    // Behauptung war schlicht falsch (kein `save()`, kein `toJSON()` an diesen
    // Objekten). `typeof candidates` sagt genau das, was tatsächlich drinsteht.
    const visible: typeof candidates = [];
    for (const doc of candidates) {
      if (actorCanAccessProject(actor, String(doc.projectId))) {
        visible.push(doc);
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
    const pid = scopedProjectId(projectId);

    // `aggregate()` ohne Typargument liefert `any[]` — damit war jeder Zugriff
    // auf `_id`/`count` ein unsafe-member-access. Das Typargument beschreibt die
    // `$group`-Ausgabe direkt daneben, es braucht also keine Behauptung.
    // Die beiden `findOne(...).lean()` trugen ein `as any`, weil `createdAt`
    // früher nicht am Typ stand; seit das Schema die Timestamps deklariert, ist
    // der Cast überflüssig.
    const [total, byLevel, byService, oldest, newest] = await Promise.all([
      this.logModel.countDocuments({ projectId: pid }),
      this.logModel.aggregate<GroupCount>([
        { $match: { projectId: pid } },
        { $group: { _id: '$level', count: { $sum: 1 } } },
      ]),
      this.logModel.aggregate<GroupCount>([
        { $match: { projectId: pid, service: { $ne: null } } },
        { $group: { _id: '$service', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ]),
      this.logModel.findOne({ projectId: pid }).sort({ createdAt: 1 }).select('createdAt').lean(),
      this.logModel.findOne({ projectId: pid }).sort({ createdAt: -1 }).select('createdAt').lean(),
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
