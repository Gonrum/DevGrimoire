import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import {
  Healthcheck,
  HealthcheckDocument,
  HealthcheckMethod,
  HealthcheckStatus,
} from './schemas/healthcheck.schema';
import {
  HealthcheckHistory,
  HealthcheckHistoryDocument,
} from './schemas/healthcheck-history.schema';
import { CreateHealthcheckDto } from './dto/create-healthcheck.dto';
import { UpdateHealthcheckDto } from './dto/update-healthcheck.dto';
import { CustomersService } from '../customers/customers.service';
import { SecretsService } from '../secrets/secrets.service';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { NotificationsService } from '../notifications/notifications.service';

const HISTORY_TTL_DAYS = 30;
const RUN_TIMEOUT_BUDGET_MS = 130_000; // hard ceiling for a check execution

export interface CustomerHealthSummary {
  customerId: string;
  total: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  paused: number;
  unknown: number;
  worstStatus: HealthcheckStatus;
}

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);
  private readonly inflight = new Set<string>();

  constructor(
    @InjectModel(Healthcheck.name) private readonly checkModel: Model<HealthcheckDocument>,
    @InjectModel(HealthcheckHistory.name)
    private readonly historyModel: Model<HealthcheckHistoryDocument>,
    private readonly customersService: CustomersService,
    private readonly secretsService: SecretsService,
    private readonly notificationsService: NotificationsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private objectId(id: string, label = 'id'): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException(`Invalid ${label}`);
    }
    return new Types.ObjectId(id);
  }

  private emit(
    action: 'created' | 'updated' | 'deleted',
    check: HealthcheckDocument,
    summarySuffix?: string,
  ): void {
    const summary = `Healthcheck "${check.name}" ${summarySuffix ?? action}`;
    this.eventEmitter.emit(PROJECT_CHANGED, {
      projectId: check.projectId?.toString() || null,
      customerId: check.customerId.toString(),
      entity: 'healthcheck',
      action,
      entityId: check._id.toString(),
      summary,
    });
  }

  async create(dto: CreateHealthcheckDto): Promise<HealthcheckDocument> {
    if (!dto.customerId) {
      throw new BadRequestException('customerId is required');
    }
    await this.customersService.findById(dto.customerId);

    try {
      const check = await this.checkModel.create({
        ...dto,
        customerId: this.objectId(dto.customerId, 'customerId'),
        projectId: dto.projectId ? this.objectId(dto.projectId, 'projectId') : undefined,
        customerProjectId: dto.customerProjectId
          ? this.objectId(dto.customerProjectId, 'customerProjectId')
          : undefined,
        environmentId: dto.environmentId
          ? this.objectId(dto.environmentId, 'environmentId')
          : undefined,
        secretHeaders: dto.secretHeaders?.map((h) => ({
          name: h.name,
          secretId: this.objectId(h.secretId, 'secretId'),
        })),
        nextRunAt: dto.active === false ? undefined : new Date(),
        lastStatus: dto.active === false ? HealthcheckStatus.PAUSED : HealthcheckStatus.UNKNOWN,
      });
      this.emit('created', check, 'angelegt');
      return check;
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(`Healthcheck "${dto.name}" existiert bereits für diesen Kunden`);
      }
      throw err;
    }
  }

  async findByCustomer(customerId: string): Promise<HealthcheckDocument[]> {
    await this.customersService.findById(customerId);
    return this.checkModel
      .find({ customerId: this.objectId(customerId, 'customerId') })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findById(id: string): Promise<HealthcheckDocument> {
    const check = await this.checkModel.findById(this.objectId(id, 'id')).exec();
    if (!check) throw new NotFoundException(`Healthcheck ${id} not found`);
    // Authorization: piggyback on customer-scope check.
    await this.customersService.findById(check.customerId.toString());
    return check;
  }

  async update(id: string, dto: UpdateHealthcheckDto): Promise<HealthcheckDocument> {
    const existing = await this.findById(id);
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};

    // Scalar fields: only $set when explicitly provided.
    for (const key of [
      'name',
      'description',
      'method',
      'url',
      'body',
      'contentType',
      'intervalSeconds',
      'timeoutMs',
      'expectedStatus',
      'expectedContent',
      'failureThreshold',
      'active',
      'headers',
    ] as const) {
      if (dto[key] !== undefined) {
        $set[key] = dto[key];
      }
    }

    // Optional ObjectId refs: null/empty string clears the field via $unset; a value sets it.
    const optionalRef = (
      key: 'projectId' | 'customerProjectId' | 'environmentId',
      label: string,
    ): void => {
      if (dto[key] === undefined) return;
      if (dto[key]) {
        $set[key] = this.objectId(dto[key] as string, label);
      } else {
        $unset[key] = '';
      }
    };
    optionalRef('projectId', 'projectId');
    optionalRef('customerProjectId', 'customerProjectId');
    optionalRef('environmentId', 'environmentId');

    if (dto.secretHeaders !== undefined) {
      $set.secretHeaders = dto.secretHeaders.map((h) => ({
        name: h.name,
        secretId: this.objectId(h.secretId, 'secretId'),
      }));
    }

    // Re-arm scheduler when interval or active state changes.
    if (dto.intervalSeconds !== undefined || dto.active !== undefined) {
      const willBeActive = dto.active ?? existing.active;
      if (willBeActive) {
        $set.nextRunAt = new Date();
        if (existing.lastStatus === HealthcheckStatus.PAUSED) {
          $set.lastStatus = HealthcheckStatus.UNKNOWN;
        }
      } else {
        $unset.nextRunAt = '';
        $set.lastStatus = HealthcheckStatus.PAUSED;
      }
    }

    const updateOps: Record<string, unknown> = {};
    if (Object.keys($set).length) updateOps.$set = $set;
    if (Object.keys($unset).length) updateOps.$unset = $unset;

    try {
      const check = await this.checkModel
        .findByIdAndUpdate(existing._id, updateOps, { new: true })
        .exec();
      if (!check) throw new NotFoundException(`Healthcheck ${id} not found`);
      this.emit('updated', check, 'aktualisiert');
      return check;
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(`Healthcheck "${dto.name}" existiert bereits für diesen Kunden`);
      }
      throw err;
    }
  }

  async remove(id: string): Promise<void> {
    const check = await this.findById(id);
    await this.checkModel.findByIdAndDelete(check._id).exec();
    await this.historyModel.deleteMany({ healthcheckId: check._id }).exec();
    this.emit('deleted', check, 'entfernt');
  }

  async listHistory(
    id: string,
    limit = 50,
    offset = 0,
  ): Promise<HealthcheckHistoryDocument[]> {
    const check = await this.findById(id);
    return this.historyModel
      .find({ healthcheckId: check._id })
      .sort({ runAt: -1 })
      .skip(Math.max(0, offset))
      .limit(Math.max(1, Math.min(limit, 500)))
      .exec();
  }

  async getCustomerSummary(customerId: string): Promise<CustomerHealthSummary> {
    await this.customersService.findById(customerId);
    const checks = await this.checkModel
      .find({ customerId: this.objectId(customerId, 'customerId') })
      .select('lastStatus active')
      .lean()
      .exec();

    const summary: CustomerHealthSummary = {
      customerId,
      total: checks.length,
      healthy: 0,
      degraded: 0,
      unhealthy: 0,
      paused: 0,
      unknown: 0,
      worstStatus: HealthcheckStatus.UNKNOWN,
    };

    for (const c of checks) {
      switch (c.lastStatus) {
        case HealthcheckStatus.HEALTHY:
          summary.healthy++;
          break;
        case HealthcheckStatus.DEGRADED:
          summary.degraded++;
          break;
        case HealthcheckStatus.UNHEALTHY:
          summary.unhealthy++;
          break;
        case HealthcheckStatus.PAUSED:
          summary.paused++;
          break;
        default:
          summary.unknown++;
      }
    }

    if (summary.unhealthy > 0) summary.worstStatus = HealthcheckStatus.UNHEALTHY;
    else if (summary.degraded > 0) summary.worstStatus = HealthcheckStatus.DEGRADED;
    else if (summary.healthy > 0) summary.worstStatus = HealthcheckStatus.HEALTHY;
    else if (summary.paused > 0 && summary.unknown === 0) summary.worstStatus = HealthcheckStatus.PAUSED;
    else summary.worstStatus = HealthcheckStatus.UNKNOWN;

    return summary;
  }

  /** Manual run requested by a user. Returns the updated check. */
  async runOnce(id: string): Promise<HealthcheckDocument> {
    const check = await this.findById(id);
    await this.executeCheck(check);
    const refreshed = await this.checkModel.findById(check._id).exec();
    if (!refreshed) throw new NotFoundException(`Healthcheck ${id} not found`);
    return refreshed;
  }

  /** Called by the scheduler. Runs all due active checks. */
  async processDueChecks(now: Date = new Date()): Promise<number> {
    const due = await this.checkModel
      .find({
        active: true,
        $or: [{ nextRunAt: { $lte: now } }, { nextRunAt: { $exists: false } }, { nextRunAt: null }],
      })
      .exec();

    let count = 0;
    for (const check of due) {
      const id = check._id.toString();
      if (this.inflight.has(id)) continue;
      this.inflight.add(id);
      try {
        await this.executeCheck(check);
        count++;
      } catch (err) {
        this.logger.error(`Healthcheck ${id} execution crashed: ${(err as Error).message}`);
      } finally {
        this.inflight.delete(id);
      }
    }
    return count;
  }

  /** Performs the HTTP request, evaluates, persists history & state, emits notifications. */
  private async executeCheck(check: HealthcheckDocument): Promise<void> {
    const startedAt = new Date();
    const headers = await this.buildHeaders(check);
    const method = check.method || HealthcheckMethod.GET;
    const controller = new AbortController();
    const timeoutMs = Math.min(check.timeoutMs || 10000, RUN_TIMEOUT_BUDGET_MS);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let statusCode: number | undefined;
    let latencyMs = 0;
    let bodySnippet: string | undefined;
    let error: string | undefined;
    let networkOk = false;

    const t0 = Date.now();
    try {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
        redirect: 'manual',
      };
      if (method !== HealthcheckMethod.GET && method !== HealthcheckMethod.HEAD && check.body) {
        init.body = check.body;
      }
      const res = await fetch(check.url, init);
      latencyMs = Date.now() - t0;
      statusCode = res.status;
      networkOk = true;
      if (check.expectedContent && method !== HealthcheckMethod.HEAD) {
        // Cap body read for safety.
        const text = await res.text();
        bodySnippet = text.slice(0, 4000);
      }
    } catch (err: any) {
      latencyMs = Date.now() - t0;
      if (err?.name === 'AbortError') {
        error = `Timeout nach ${timeoutMs}ms`;
      } else {
        error = err?.message || 'Unbekannter Fehler';
      }
    } finally {
      clearTimeout(timer);
    }

    const evaluation = this.evaluate(check, networkOk, statusCode, bodySnippet, error);

    const previousStatus = check.lastStatus;
    let consecutiveFailures = check.consecutiveFailures || 0;
    let consecutiveSuccesses = check.consecutiveSuccesses || 0;

    if (evaluation.success) {
      consecutiveSuccesses++;
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      consecutiveSuccesses = 0;
    }

    const newStatus: HealthcheckStatus = evaluation.success
      ? HealthcheckStatus.HEALTHY
      : consecutiveFailures >= (check.failureThreshold || 2)
        ? HealthcheckStatus.UNHEALTHY
        : HealthcheckStatus.DEGRADED;

    const nextRunAt = new Date(startedAt.getTime() + (check.intervalSeconds || 300) * 1000);

    await this.historyModel.create({
      healthcheckId: check._id,
      customerId: check.customerId,
      runAt: startedAt,
      status: newStatus,
      statusCode,
      latencyMs,
      error: evaluation.success ? undefined : evaluation.errorMessage || error,
      expiresAt: new Date(startedAt.getTime() + HISTORY_TTL_DAYS * 24 * 60 * 60 * 1000),
    });

    await this.checkModel.findByIdAndUpdate(check._id, {
      lastStatus: newStatus,
      lastRunAt: startedAt,
      lastLatencyMs: latencyMs,
      lastStatusCode: statusCode,
      lastError: evaluation.success ? undefined : evaluation.errorMessage || error,
      consecutiveFailures,
      consecutiveSuccesses,
      nextRunAt,
    }).exec();

    // Status transition handling — emit event + push notification.
    if (newStatus !== previousStatus) {
      this.eventEmitter.emit(PROJECT_CHANGED, {
        projectId: check.projectId?.toString() || null,
        customerId: check.customerId.toString(),
        entity: 'healthcheck',
        action: 'updated',
        entityId: check._id.toString(),
        summary: `Healthcheck "${check.name}": ${previousStatus} → ${newStatus}`,
      });

      // Only notify on transitions into UNHEALTHY or recovery from UNHEALTHY.
      const wasUnhealthy = previousStatus === HealthcheckStatus.UNHEALTHY;
      const isUnhealthy = newStatus === HealthcheckStatus.UNHEALTHY;
      const monitoringUrl = `/customers/${check.customerId.toString()}?tab=monitoring`;
      if (isUnhealthy && check.lastNotifiedStatus !== HealthcheckStatus.UNHEALTHY) {
        await this.safeNotify(
          `🔴 ${check.name} ist nicht erreichbar`,
          evaluation.errorMessage || error || `HTTP ${statusCode}`,
          monitoringUrl,
        );
        await this.checkModel.findByIdAndUpdate(check._id, {
          lastNotifiedStatus: HealthcheckStatus.UNHEALTHY,
        }).exec();
      } else if (!isUnhealthy && wasUnhealthy) {
        await this.safeNotify(
          `🟢 ${check.name} wieder verfügbar`,
          `HTTP ${statusCode ?? '-'} in ${latencyMs}ms`,
          monitoringUrl,
        );
        await this.checkModel.findByIdAndUpdate(check._id, {
          lastNotifiedStatus: newStatus,
        }).exec();
      }
    }
  }

  private async safeNotify(title: string, body: string, url?: string): Promise<void> {
    try {
      await this.notificationsService.create(title, body, url, 'monitoring');
    } catch (err) {
      this.logger.warn(`Failed to dispatch monitoring notification: ${(err as Error).message}`);
    }
  }

  private evaluate(
    check: HealthcheckDocument,
    networkOk: boolean,
    statusCode: number | undefined,
    bodySnippet: string | undefined,
    networkError: string | undefined,
  ): { success: boolean; errorMessage?: string } {
    if (!networkOk || statusCode === undefined) {
      return { success: false, errorMessage: networkError || 'Netzwerkfehler' };
    }

    const expected = check.expectedStatus && check.expectedStatus.length > 0
      ? check.expectedStatus
      : null;

    if (expected) {
      if (!expected.includes(statusCode)) {
        return {
          success: false,
          errorMessage: `Status ${statusCode}, erwartet: ${expected.join('/')}`,
        };
      }
    } else if (statusCode < 200 || statusCode >= 300) {
      return { success: false, errorMessage: `HTTP ${statusCode}` };
    }

    if (check.expectedContent && check.expectedContent.length > 0) {
      if (!bodySnippet || !bodySnippet.includes(check.expectedContent)) {
        return {
          success: false,
          errorMessage: `Erwarteter Inhalt nicht gefunden: "${check.expectedContent.slice(0, 60)}"`,
        };
      }
    }

    return { success: true };
  }

  private async buildHeaders(check: HealthcheckDocument): Promise<Record<string, string>> {
    const out: Record<string, string> = {};

    if (check.body && check.method !== HealthcheckMethod.GET && check.method !== HealthcheckMethod.HEAD) {
      out['Content-Type'] = check.contentType || 'application/json';
    }

    for (const h of check.headers || []) {
      if (!h?.name) continue;
      out[h.name] = h.value ?? '';
    }

    for (const sh of check.secretHeaders || []) {
      if (!sh?.name || !sh?.secretId) continue;
      try {
        const secret = await this.secretsService.findById(sh.secretId.toString());
        out[sh.name] = secret.value;
      } catch (err) {
        this.logger.warn(
          `Healthcheck ${check._id} could not resolve secret ${sh.secretId}: ${(err as Error).message}`,
        );
      }
    }
    return out;
  }

  // ---- Cascade cleanup -----------------------------------------------------

  @OnEvent(PROJECT_CHANGED)
  async handleCascade(event: ProjectChangeEvent): Promise<void> {
    if (event.action !== 'deleted') return;
    if (event.entity === 'customer' && event.entityId) {
      await this.removeByCustomer(event.entityId);
    } else if (event.entity === 'project' && event.entityId) {
      await this.removeByProject(event.entityId);
    } else if (event.entity === 'environment' && event.entityId) {
      // Detach environment reference instead of deleting the check entirely.
      await this.checkModel
        .updateMany(
          { environmentId: this.objectId(event.entityId, 'environmentId') },
          { $unset: { environmentId: '' } },
        )
        .exec();
    } else if (event.entity === 'secret' && event.entityId) {
      await this.checkModel
        .updateMany(
          { 'secretHeaders.secretId': this.objectId(event.entityId, 'secretId') },
          { $pull: { secretHeaders: { secretId: this.objectId(event.entityId, 'secretId') } } },
        )
        .exec();
    }
  }

  async removeByCustomer(customerId: string): Promise<void> {
    if (!Types.ObjectId.isValid(customerId)) return;
    const oid = new Types.ObjectId(customerId);
    const ids = await this.checkModel.find({ customerId: oid }).distinct('_id').exec();
    if (ids.length === 0) return;
    await this.historyModel.deleteMany({ healthcheckId: { $in: ids } }).exec();
    await this.checkModel.deleteMany({ _id: { $in: ids } }).exec();
  }

  async removeByProject(projectId: string): Promise<void> {
    if (!Types.ObjectId.isValid(projectId)) return;
    const oid = new Types.ObjectId(projectId);
    // Project-bound checks (customer monitor a project) — delete; environment-only refs handled separately.
    const ids = await this.checkModel.find({ projectId: oid }).distinct('_id').exec();
    if (ids.length === 0) return;
    await this.historyModel.deleteMany({ healthcheckId: { $in: ids } }).exec();
    await this.checkModel.deleteMany({ _id: { $in: ids } }).exec();
  }
}
