import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { SettingsService } from '../settings/settings.service';
import { ProjectsService } from '../projects/projects.service';
import { ReplicationApplied, ReplicationAppliedDocument } from './schemas/replication-applied.schema';
import { isReplicatedCollection } from './replication-collections';
import { compareLww, makeAppliedKey } from './replication-log.helpers';
import { toMs } from './replication-sync.helpers';
import { SyncLogEntry, SyncEntryResult } from './replication-sync.types';
import { REPL_INSTANCE_ID } from './replication.constants';

/** ObjectId-typed fields that arrive as strings over JSON and must be cast back. */
const OBJECTID_FIELDS = ['projectId', 'customerId', 'milestoneId', 'entityId'];

@Injectable()
export class ReplicationSyncApplyService {
  private readonly logger = new Logger(ReplicationSyncApplyService.name);
  private selfInstanceId: string | null = null;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(ReplicationApplied.name) private appliedModel: Model<ReplicationAppliedDocument>,
    private settingsService: SettingsService,
    private projectsService: ProjectsService,
  ) {}

  private async getSelfInstanceId(): Promise<string | null> {
    if (this.selfInstanceId) return this.selfInstanceId;
    this.selfInstanceId = await this.settingsService.get(REPL_INSTANCE_ID);
    return this.selfInstanceId;
  }

  /** Opt-in: the entry's project must exist locally AND be replication-enabled.
   *  Bootstrap exception: an incoming `projects` upsert whose own
   *  replicationConfig.enabled === true is allowed (the project may not exist
   *  locally yet). */
  private async isAllowed(entry: SyncLogEntry): Promise<{ ok: boolean; reason?: string }> {
    if (!entry.projectId) return { ok: false, reason: 'no projectId' };
    if (entry.collection === 'projects' && entry.op === 'upsert') {
      const cfg = (entry.document?.replicationConfig as { enabled?: boolean } | undefined);
      if (cfg?.enabled === true) return { ok: true };
    }
    try {
      const enabled = await this.projectsService.isReplicationEnabled(entry.projectId);
      return enabled ? { ok: true } : { ok: false, reason: 'project not replication-enabled' };
    } catch {
      return { ok: false, reason: 'project not found locally — bootstrap required' };
    }
  }

  async applyEntry(entry: SyncLogEntry): Promise<SyncEntryResult> {
    const seq = entry.seq;

    // Defensive echo guard (the server already filters origin==self out, but a
    // misconfigured peer could still send it).
    const self = await this.getSelfInstanceId();
    if (self && entry.originInstanceId === self) {
      return { seq, applied: false, outcome: 'skipped_echo', reason: 'own origin — skipped' };
    }
    if (!isReplicatedCollection(entry.collection)) {
      return { seq, applied: false, outcome: 'skipped_notreplicated', reason: `not a replicated collection: ${entry.collection}` };
    }
    const allowed = await this.isAllowed(entry);
    if (!allowed.ok) return { seq, applied: false, outcome: 'skipped_optin', reason: allowed.reason };

    const db = this.connection.db;
    if (!db) return { seq, applied: false, outcome: 'error_transient', reason: 'db unavailable' };
    const { ObjectId } = await import('mongodb');
    const coll = db.collection(entry.collection);

    let oid: InstanceType<typeof ObjectId>;
    try { oid = new ObjectId(entry.documentId); }
    catch { return { seq, applied: false, outcome: 'skipped_invalid', reason: 'invalid documentId' }; }

    try {
      // LWW: read the local doc's updatedAt once.
      const local = await coll.findOne({ _id: oid }, { projection: { updatedAt: 1 } });
      const localMs = local ? toMs((local as { updatedAt?: unknown }).updatedAt) : null;

      if (entry.op === 'delete') {
        if (compareLww(localMs, entry.deletedAtMs) === 'skip') {
          return { seq, applied: false, outcome: 'skipped_lww', reason: 'LWW: local newer than delete' };
        }
        await coll.deleteOne({ _id: oid });
        return { seq, applied: true, outcome: 'applied' };
      }

      if (!entry.document) return { seq, applied: false, outcome: 'skipped_invalid', reason: 'no document for upsert' };
      if (compareLww(localMs, entry.updatedAtMs) === 'skip') {
        return { seq, applied: false, outcome: 'skipped_lww', reason: 'LWW: local newer' };
      }

      // Origin tagging: write the applied-record BEFORE the upsert so the local
      // change stream tags the re-emitted log entry with the REMOTE origin
      // (→ filtered from push-back). Keyed by collection:_id:updatedAtMs.
      if (entry.updatedAtMs != null) {
        const appliedKey = makeAppliedKey(entry.collection, entry.documentId, entry.updatedAtMs);
        await this.appliedModel.updateOne(
          { appliedKey },
          { $set: { appliedKey, originInstanceId: entry.originInstanceId } },
          { upsert: true },
        );
      }

      const doc: Record<string, unknown> = { ...entry.document };
      delete doc._id;
      for (const f of OBJECTID_FIELDS) {
        if (typeof doc[f] === 'string') {
          try { doc[f] = new ObjectId(doc[f] as string); } catch { /* leave as-is */ }
        }
      }
      if (Array.isArray(doc.blockedBy)) {
        doc.blockedBy = (doc.blockedBy as string[]).map((id) => {
          try { return new ObjectId(id); } catch { return id; }
        });
      }
      this.normalizeTimestamps(doc);

      await coll.replaceOne({ _id: oid }, doc, { upsert: true });
      return { seq, applied: true, outcome: 'applied' };
    } catch (err) {
      this.logger.error(`Sync apply failed (${entry.collection}/${entry.documentId}): ${(err as Error).message}`);
      return { seq, applied: false, outcome: 'error_transient', reason: (err as Error).message };
    }
  }

  /** Convert ISO-string timestamps (JSON transport) back to Date so BSON
   *  comparisons and the change-stream updatedAtMs round-trip correctly. */
  private normalizeTimestamps(doc: Record<string, unknown>): void {
    for (const field of ['createdAt', 'updatedAt', 'timestamp', 'expiresAt', 'lastUsedAt', 'lastAttempt']) {
      const v = doc[field];
      if (typeof v === 'string') {
        const d = new Date(v);
        if (!Number.isNaN(d.getTime())) doc[field] = d;
      }
    }
  }
}
