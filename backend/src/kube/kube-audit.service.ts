import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  KubeAudit, KubeAuditAction, KubeAuditDocument, KubeAuditSourceContext,
} from './schemas/kube-audit.schema';
import { errorMessage } from '../common/narrow';

export interface KubeAuditEntry {
  clusterId: string;
  action: KubeAuditAction;
  sourceContext: KubeAuditSourceContext;
  userId: string;
  verb?: string;
  resource?: string;
  namespace?: string;
  name?: string;
  durationMs?: number;
  errorMsg?: string;
}

@Injectable()
export class KubeAuditService {
  private readonly logger = new Logger(KubeAuditService.name);

  constructor(
    @InjectModel(KubeAudit.name) private readonly auditModel: Model<KubeAuditDocument>,
  ) {}

  /**
   * Schreibt eine Audit-Zeile. Schlägt der Schreibvorgang fehl, wird das
   * geloggt statt geworfen — ein kaputtes Audit darf den Aufruf nicht
   * scheitern lassen, den es protokollieren soll.
   */
  async record(entry: KubeAuditEntry): Promise<void> {
    try {
      await this.auditModel.create({
        clusterId: new Types.ObjectId(entry.clusterId),
        at: new Date(),
        action: entry.action,
        sourceContext: entry.sourceContext,
        userId: new Types.ObjectId(entry.userId),
        verb: entry.verb,
        resource: entry.resource,
        namespace: entry.namespace,
        name: entry.name,
        durationMs: entry.durationMs,
        errorMsg: entry.errorMsg?.slice(0, 500),
      });
    } catch (err) {
      this.logger.warn(`Audit-Zeile nicht geschrieben: ${errorMessage(err)}`);
    }
  }

  async list(
    clusterId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ items: KubeAuditDocument[]; total: number }> {
    if (!Types.ObjectId.isValid(clusterId)) {
      // Nie einen ungeprüften Wert in den Filter geben.
      return { items: [], total: 0 };
    }
    const filter = { clusterId: new Types.ObjectId(clusterId) };
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const [items, total] = await Promise.all([
      this.auditModel.find(filter).sort({ at: -1 }).skip(offset).limit(limit).exec(),
      this.auditModel.countDocuments(filter).exec(),
    ]);
    return { items, total };
  }
}
