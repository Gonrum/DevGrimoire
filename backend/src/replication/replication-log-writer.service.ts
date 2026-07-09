import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { SettingsService } from '../settings/settings.service';
import { ReplicationLog, ReplicationLogDocument } from './schemas/replication-log.schema';
import { ReplicationApplied, ReplicationAppliedDocument } from './schemas/replication-applied.schema';
import { ReplicationCounterService } from './replication-counter.service';
import { isReplicatedCollection, getReplicatedByCollection, replicatedCollectionNames } from './replication-collections';
import { mapOperation, deriveEventId, makeAppliedKey } from './replication-log.helpers';
import { REPL_WATCHER_RESUME_TOKEN, REPL_INSTANCE_ID } from './replication.constants';

/**
 * Dedicated change-stream consumer that captures every write to a replicated
 * collection into replication_log. Separate from EventsBusService so its
 * options (updateLookup) and resume token are independent. Crash-safe: the
 * resume token is persisted after each entry, so a restart resumes exactly.
 *
 * Origin tagging: before applying a remote change, the apply path (Plan 2)
 * writes a replication_applied record keyed by collection:_id:updatedAtMs.
 * Here we look it up; a hit means the write originated remotely (tag with that
 * instance, filtered from push-back); a miss means a local user write (self).
 */
@Injectable()
export class ReplicationLogWriterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReplicationLogWriterService.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private changeStream: any = null;
  private readonly standalone: boolean;
  private selfInstanceId: string | null = null;
  private closing = false;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(ReplicationLog.name) private logModel: Model<ReplicationLogDocument>,
    @InjectModel(ReplicationApplied.name) private appliedModel: Model<ReplicationAppliedDocument>,
    private counter: ReplicationCounterService,
    private settingsService: SettingsService,
  ) {
    this.standalone = process.env.MONGODB_STANDALONE === 'true';
  }

  async onModuleInit() {
    if (this.standalone) {
      this.logger.log('Standalone mode: replication log writer disabled (no change streams)');
      return;
    }
    await this.start();
  }

  onModuleDestroy() {
    this.closing = true;
    this.changeStream?.close();
  }

  private async getSelfInstanceId(): Promise<string> {
    if (this.selfInstanceId) return this.selfInstanceId;
    let id = await this.settingsService.get(REPL_INSTANCE_ID);
    if (!id) {
      id = randomUUID();
      await this.settingsService.set(REPL_INSTANCE_ID, id);
    }
    this.selfInstanceId = id;
    return id;
  }

  private async start() {
    const db = this.connection.db;
    if (!db) {
      this.logger.warn('Database not available — log writer not started');
      return;
    }

    const watched = replicatedCollectionNames();
    const pipeline = [{ $match: { 'ns.coll': { $in: watched } } }];

    // Resume from the persisted token if present.
    const tokenRaw = await this.settingsService.get(REPL_WATCHER_RESUME_TOKEN);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: any = { fullDocument: 'updateLookup' };
    if (tokenRaw) {
      try {
        options.resumeAfter = JSON.parse(tokenRaw);
      } catch {
        this.logger.warn('Stored resume token unparseable — starting fresh');
      }
    }

    try {
      this.changeStream = db.watch(pipeline, options);
      this.logger.log(`Replication log writer watching: ${watched.join(', ')}`);
      // Drive the stream with an async iterator (NOT fire-and-forget .on('change')):
      // for-await pulls the next event only after the current handleChange resolves,
      // so each log entry is durable AND its resume token persisted before the next
      // event — strict order + back-pressure. A concurrent handler would let a fast
      // event advance the token past a slow event still mid-write, losing it on crash.
      void this.consume();
    } catch (err) {
      this.logger.warn(`Change streams unavailable — log writer inactive: ${(err as Error).message}`);
    }
  }

  /** Serial consumer loop. One handleChange at a time, in oplog order. */
  private async consume(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const change of this.changeStream as AsyncIterable<any>) {
        if (this.closing) break;
        await this.handleChange(change);
      }
    } catch (err) {
      // ChangeStreamHistoryLost (resume token aged out of oplog) → Plan 3 auto full-sync.
      // For now: log prominently; suppress noise during shutdown.
      if (!this.closing) {
        this.logger.error(`Replication change stream error: ${(err as Error).message}`);
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleChange(change: any): Promise<void> {
    if (this.closing) return;
    try {
      const coll: string = change.ns?.coll;
      if (!coll || !isReplicatedCollection(coll)) return;

      const op = mapOperation(change.operationType);
      if (!op) return;

      const documentId: string | undefined = (change.documentKey?._id || change.fullDocument?._id)?.toString();
      if (!documentId) return;

      // clusterTime is a BSON Timestamp {t, i}; use seconds*1000 for ms epoch.
      const clusterTimeMs = (Number(change.clusterTime?.t) || Math.floor(Date.now() / 1000)) * 1000;
      // The resume token `_data` is globally unique per change event and stable
      // across crash-resume re-delivery → the ideal idempotency key. We fall
      // back to clusterTime only if it is somehow absent. (clusterTimeMs alone
      // has second granularity: two writes to the same doc within one second
      // would collide on eventId and the unique index would DROP the second —
      // silent data loss. The resume-token disambiguator prevents that.)
      const resumeData: string | undefined = change._id?._data;
      const eventId = resumeData
        ? `${coll}:${documentId}:${resumeData}`
        : deriveEventId(coll, documentId, clusterTimeMs);

      const fullDoc = change.fullDocument ?? null;
      const { projectId, projectIds } = this.extractProjectRefs(coll, fullDoc, documentId);
      const updatedAtMs = this.toMs(fullDoc?.updatedAt);
      const deletedAtMs = op === 'delete' ? clusterTimeMs : null;

      // Origin tagging via loopback-suppression lookup.
      const self = await this.getSelfInstanceId();
      let origin = self;
      // Deletes are always tagged origin=self (no applied-record for deletes); per spec §7.2 LWW+origin-filter on the receiver guarantees loop termination regardless — at most one redundant round-trip.
      if (op === 'upsert' && updatedAtMs != null) {
        const appliedKey = makeAppliedKey(coll, documentId, updatedAtMs);
        const hit = await this.appliedModel.findOne({ appliedKey }).lean().exec();
        if (hit) origin = hit.originInstanceId;
      }

      // seq assigned before insert; a duplicate eventId (11000, resume replay) discards this number — harmless gap, see schema.
      const seq = await this.counter.nextSeq();

      try {
        await this.logModel.create({
          seq,
          eventId,
          op,
          collection: coll,
          documentId,
          projectId,
          projectIds,
          document: op === 'upsert' ? fullDoc : null,
          updatedAtMs,
          deletedAtMs,
          originInstanceId: origin,
        });
      } catch (err) {
        // Duplicate eventId (idempotent re-process after resume) — safe to skip.
        if ((err as { code?: number }).code === 11000) {
          this.logger.debug(`Duplicate eventId ${eventId} — skipped`);
        } else {
          throw err;
        }
      }

      // Persist resume token AFTER the entry is durable.
      if (change._id) {
        await this.settingsService.set(REPL_WATCHER_RESUME_TOKEN, JSON.stringify(change._id));
      }
    } catch (err) {
      this.logger.error(`Failed to write replication log entry: ${(err as Error).message}`);
    }
  }

  /** Project references for the log entry. Single-project: `projectId` set,
   *  `projectIds` null. Multi-project (multiProject registry flag): `projectId`
   *  null, `projectIds` = the doc's projectIds array. The projects collection
   *  itself uses its own _id as projectId. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractProjectRefs(coll: string, doc: any, documentId: string): {
    projectId: string | null;
    projectIds: string[] | null;
  } {
    const entry = getReplicatedByCollection(coll);
    if (entry?.entity === 'project') return { projectId: documentId, projectIds: null };
    if (entry?.multiProject) {
      // ResearchTopic nests its opt-in project list under `scope.projectIds[]`
      // (part of the run-scope object) rather than a top-level `projectIds[]`.
      // Entity-specific so a future top-level multiProject entity takes the
      // generic (top-level) path unchanged.
      const raw = entry.entity === 'research-topic' ? doc?.scope?.projectIds : doc?.projectIds;
      const arr = Array.isArray(raw) ? raw : [];
      return { projectId: null, projectIds: arr.map((p: unknown) => String(p)) };
    }
    const pid = doc?.projectId;
    return { projectId: pid != null ? pid.toString() : null, projectIds: null };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toMs(value: any): number | null {
    if (value == null) return null;
    const d = value instanceof Date ? value : new Date(value);
    const t = d.getTime();
    return Number.isNaN(t) ? null : t;
  }
}
