import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditLog, AuditLogDocument } from './schemas/audit-log.schema';
import { RequestContext } from '../common/request-context';

export interface AuditRecordInput {
  action: string;
  entityType?: string;
  entityId?: string;
  meta?: Record<string, unknown>;
  /** Override actor explicitly (for cron jobs / system-driven events). */
  actor?: {
    userId?: string;
    username?: string;
    role?: string;
    apiKeyId?: string;
  };
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditQueryFilters {
  action?: string;
  /** T-339: filter rows whose action starts with this prefix, e.g. `apikey.` */
  actionPrefix?: string;
  actorUserId?: string;
  /** T-339: filter by actor source — user (actorUserId), apikey (actorApiKeyId), system (neither). */
  actorType?: 'user' | 'apikey' | 'system';
  entityType?: string;
  entityId?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectModel(AuditLog.name) private auditLogModel: Model<AuditLogDocument>,
  ) {}

  /**
   * Records an audit event. Never throws — audit failures must not break the
   * primary action (which is presumably already underway when this is called).
   * Errors are logged at warn level so devops still sees them.
   */
  async record(input: AuditRecordInput): Promise<void> {
    try {
      const ctx = RequestContext.getUser();
      const actor = input.actor;
      const entityIdObj =
        input.entityId && Types.ObjectId.isValid(input.entityId)
          ? new Types.ObjectId(input.entityId)
          : undefined;
      const apiKeyIdObj =
        actor?.apiKeyId && Types.ObjectId.isValid(actor.apiKeyId)
          ? new Types.ObjectId(actor.apiKeyId)
          : ctx?.apiKeyId && Types.ObjectId.isValid(ctx.apiKeyId)
            ? new Types.ObjectId(ctx.apiKeyId)
            : undefined;
      const actorUserIdObj =
        actor?.userId && Types.ObjectId.isValid(actor.userId)
          ? new Types.ObjectId(actor.userId)
          : ctx?.userId && Types.ObjectId.isValid(ctx.userId)
            ? new Types.ObjectId(ctx.userId)
            : undefined;
      await this.auditLogModel.create({
        action: input.action,
        actorUserId: actorUserIdObj,
        actorUsername: actor?.username ?? ctx?.username,
        actorRole: actor?.role ?? ctx?.role,
        actorApiKeyId: apiKeyIdObj,
        entityType: input.entityType,
        entityId: entityIdObj,
        meta: input.meta,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
    } catch (err) {
      this.logger.warn(`Audit record failed for action "${input.action}": ${(err as Error).message}`);
    }
  }

  async findAll(filters: AuditQueryFilters = {}): Promise<{
    items: AuditLogDocument[];
    total: number;
  }> {
    const query = this.buildQuery(filters);
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
    const offset = Math.max(filters.offset ?? 0, 0);

    const [items, total] = await Promise.all([
      this.auditLogModel.find(query).sort({ timestamp: -1 }).skip(offset).limit(limit).exec(),
      this.auditLogModel.countDocuments(query).exec(),
    ]);

    return { items, total };
  }

  /**
   * T-339: streamable export path. Hard cap at 10 000 rows so a careless
   * filter doesn't drag the whole collection through the API. Caller
   * (frontend) shows a hint when this limit hits.
   */
  async exportAll(filters: AuditQueryFilters = {}): Promise<{ items: AuditLogDocument[]; truncated: boolean }> {
    const EXPORT_CAP = 10_000;
    const query = this.buildQuery(filters);
    const items = await this.auditLogModel
      .find(query)
      .sort({ timestamp: -1 })
      .limit(EXPORT_CAP + 1)
      .lean()
      .exec() as unknown as AuditLogDocument[];
    const truncated = items.length > EXPORT_CAP;
    return { items: truncated ? items.slice(0, EXPORT_CAP) : items, truncated };
  }

  private buildQuery(filters: AuditQueryFilters): Record<string, unknown> {
    const query: Record<string, unknown> = {};
    if (filters.action) query.action = filters.action;
    // actionPrefix is OR-combined with action: if both provided, action wins
    // (exact-match is more specific than prefix). Mongo regex needs the
    // pattern escaped — only alphanum + `.` here, but stay safe.
    if (filters.actionPrefix && !filters.action) {
      const safe = filters.actionPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.action = { $regex: `^${safe}` };
    }
    if (filters.actorUserId && Types.ObjectId.isValid(filters.actorUserId)) {
      query.actorUserId = new Types.ObjectId(filters.actorUserId);
    }
    if (filters.actorType === 'user') {
      query.actorUserId = { ...((query.actorUserId) ?? {}), $exists: true };
    } else if (filters.actorType === 'apikey') {
      query.actorApiKeyId = { $exists: true };
    } else if (filters.actorType === 'system') {
      query.actorUserId = { $exists: false };
      query.actorApiKeyId = { $exists: false };
    }
    if (filters.entityType) query.entityType = filters.entityType;
    if (filters.entityId && Types.ObjectId.isValid(filters.entityId)) {
      query.entityId = new Types.ObjectId(filters.entityId);
    }
    if (filters.since || filters.until) {
      const ts: Record<string, Date> = {};
      if (filters.since) ts.$gte = filters.since;
      if (filters.until) ts.$lte = filters.until;
      query.timestamp = ts;
    }
    return query;
  }

  async distinctActions(): Promise<string[]> {
    return this.auditLogModel.distinct('action').exec();
  }
}
