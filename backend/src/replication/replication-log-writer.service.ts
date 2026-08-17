import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, mongo } from 'mongoose';
import { randomUUID } from 'crypto';
import { SettingsService } from '../settings/settings.service';
import { ReplicationLog, ReplicationLogDocument } from './schemas/replication-log.schema';
import { ReplicationApplied, ReplicationAppliedDocument } from './schemas/replication-applied.schema';
import { ReplicationCounterService } from './replication-counter.service';
import { isReplicatedCollection, getReplicatedByCollection, replicatedCollectionNames } from './replication-collections';
import { mapOperation, deriveEventId, makeAppliedKey } from './replication-log.helpers';
import { REPL_WATCHER_RESUME_TOKEN, REPL_INSTANCE_ID, REPL_WATCHER_HEARTBEAT } from './replication.constants';

/**
 * Absichtlich offene Dokumentform: der Watcher sieht alle replizierten
 * Collections, ein konkreter Typ wäre hier eine Lüge. Ohne explizites TSchema
 * fällt der Treiber auf `Document` = `{[k: string]: any}` zurück — dann wäre
 * jedes Feld wieder `any`.
 */
type ReplDoc = { _id?: unknown; [field: string]: unknown };
type ReplChange = mongo.ChangeStreamDocument<ReplDoc>;

/**
 * Genau die vier Operationen, die `mapOperation()` abbildet. Alles andere
 * (drop, rename, invalidate, Index-Events) wird verworfen — vorher über
 * `mapOperation() === null`, jetzt schon am Guard. Gleiches Ergebnis, aber
 * erst dieses Narrowing gibt typisierten Zugriff auf `ns`/`documentKey`.
 */
const DOCUMENT_OPERATIONS = ['insert', 'update', 'replace', 'delete'] as const;
type ReplDocumentChange = Extract<
  ReplChange,
  { operationType: (typeof DOCUMENT_OPERATIONS)[number] }
>;

function isDocumentChange(change: ReplChange): change is ReplDocumentChange {
  return DOCUMENT_OPERATIONS.some((operation) => operation === change.operationType);
}

/**
 * Mongo-Id zu String. Nur String, Number und ObjectId-artige Werte gelten —
 * ein blankes `String(value)` hätte für ein Objekt `[object Object]` als
 * Dokument-Id ins Log geschrieben.
 */
function idToPlainString(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (typeof value === 'number') return String(value);
  if (value instanceof mongo.ObjectId) return value.toHexString();
  return undefined;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Liest das `_data` des Resume-Tokens, das als Idempotenz-Disambiguator dient. */
function resumeTokenData(token: unknown): string | undefined {
  if (token === null || typeof token !== 'object') return undefined;
  const data = (token as { _data?: unknown })._data;
  return typeof data === 'string' ? data : undefined;
}

/** How often the watcher stamps its liveness heartbeat while consuming. */
const HEARTBEAT_INTERVAL_MS = 30_000;

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
  private changeStream: mongo.ChangeStream<ReplDoc, ReplChange> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
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
    this.stopHeartbeat();
    // Fire-and-forget bleibt gewollt (der Shutdown soll nicht darauf warten),
    // aber die Rejection war unbehandelt — beim Herunterfahren also eine
    // potenzielle UnhandledRejection. Nur das `any` hat sie verdeckt.
    this.changeStream?.close().catch((err: unknown) => {
      this.logger.warn(`Closing change stream failed: ${(err as Error).message}`);
    });
  }

  /** Stamp a liveness heartbeat now + every HEARTBEAT_INTERVAL_MS while the
   *  consume loop is alive. The timer is cleared when consume() exits, so the
   *  heartbeat goes stale exactly when the watcher dies (→ detectable in
   *  getSyncStatus), even while the stream is idle. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    void this.stampHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.stampHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async stampHeartbeat(): Promise<void> {
    try {
      await this.settingsService.set(REPL_WATCHER_HEARTBEAT, new Date().toISOString());
    } catch (err) {
      this.logger.warn(`Heartbeat stamp failed: ${(err as Error).message}`);
    }
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

  /**
   * Enable change-stream pre-images on every replicated collection so DELETE
   * events carry the pre-delete document (→ its projectId). Idempotent: collMod
   * with the same setting is a no-op. A collection that doesn't exist yet is
   * skipped (enabled on the next restart after it's created). Any other failure
   * is logged (deletes for that collection won't replicate) but does not stop
   * the watcher.
   */
  private async ensurePreImages(db: mongo.Db, collections: string[]): Promise<void> {
    for (const coll of collections) {
      try {
        await db.command({ collMod: coll, changeStreamPreAndPostImages: { enabled: true } });
      } catch (err) {
        const e = err as { codeName?: string; message?: string };
        if (e.codeName === 'NamespaceNotFound') continue; // created later → enabled on next start
        this.logger.warn(
          `Could not enable pre-images on ${coll} (deletes may not replicate): ${e.message}`,
        );
      }
    }
  }

  private async start() {
    const db = this.connection.db;
    if (!db) {
      this.logger.warn('Database not available — log writer not started');
      return;
    }

    const watched = replicatedCollectionNames();
    // Ensure DELETE events will carry the deleted doc's projectId (pre-images).
    await this.ensurePreImages(db, watched);
    const pipeline = [{ $match: { 'ns.coll': { $in: watched } } }];

    // Resume from the persisted token if present.
    const tokenRaw = await this.settingsService.get(REPL_WATCHER_RESUME_TOKEN);
    const options: mongo.ChangeStreamOptions = {
      fullDocument: 'updateLookup',
      fullDocumentBeforeChange: 'whenAvailable',
    };
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
      this.startHeartbeat();
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
      if (!this.changeStream) return;
      for await (const change of this.changeStream) {
        if (this.closing) break;
        await this.handleChange(change);
      }
    } catch (err) {
      // ChangeStreamHistoryLost (resume token aged out of oplog) → Plan 3 auto full-sync.
      // For now: log prominently; suppress noise during shutdown.
      if (!this.closing) {
        this.logger.error(`Replication change stream error: ${(err as Error).message}`);
      }
    } finally {
      // Watcher loop ended (error or shutdown) → stop stamping so the heartbeat
      // goes stale and getSyncStatus can surface a dead watcher.
      this.stopHeartbeat();
    }
  }

  private async handleChange(change: ReplChange): Promise<void> {
    if (this.closing) return;
    try {
      // Erst auf die dokument-bezogenen Operationen verengen: vorher filterte
      // `mapOperation() === null` dieselben Events heraus, nur eben nach dem
      // ns-Zugriff. Beide Prüfungen sind nebenwirkungsfreie Early-Returns, die
      // Reihenfolge ist also nicht beobachtbar.
      if (!isDocumentChange(change)) return;

      const coll = change.ns.coll;
      if (!coll || !isReplicatedCollection(coll)) return;

      const op = mapOperation(change.operationType);
      if (!op) return;

      const fullDocId = 'fullDocument' in change ? change.fullDocument?._id : undefined;
      const documentId = idToPlainString(change.documentKey._id ?? fullDocId);
      if (!documentId) return;

      // clusterTime is a BSON Timestamp {t, i}; use seconds*1000 for ms epoch.
      const clusterTimeMs = (Number(change.clusterTime?.t) || Math.floor(Date.now() / 1000)) * 1000;
      // The resume token `_data` is globally unique per change event and stable
      // across crash-resume re-delivery → the ideal idempotency key. We fall
      // back to clusterTime only if it is somehow absent. (clusterTimeMs alone
      // has second granularity: two writes to the same doc within one second
      // would collide on eventId and the unique index would DROP the second —
      // silent data loss. The resume-token disambiguator prevents that.)
      const resumeData = resumeTokenData(change._id);
      const eventId = resumeData
        ? `${coll}:${documentId}:${resumeData}`
        : deriveEventId(coll, documentId, clusterTimeMs);

      const fullDoc = ('fullDocument' in change ? change.fullDocument : null) ?? null;
      // On a delete, fullDocument is null (updateLookup can't find the gone doc);
      // the pre-image carries the deleted doc → its projectId(s). Upserts keep
      // using fullDocument (unchanged). Without a pre-image (collection not
      // enabled / expired) refDoc is null → projectId null → the delete is
      // filtered out downstream, i.e. no worse than before this plan.
      const preImage =
        ('fullDocumentBeforeChange' in change ? change.fullDocumentBeforeChange : null) ?? null;
      const refDoc = op === 'delete' ? preImage : fullDoc;
      const { projectId, projectIds } = this.extractProjectRefs(coll, refDoc, documentId);
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
  private extractProjectRefs(coll: string, doc: ReplDoc | null, documentId: string): {
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
      // ResearchTopic verschachtelt seine Opt-in-Liste unter `scope.projectIds[]`.
      const scope = doc?.scope;
      const nested =
        scope !== null && typeof scope === 'object'
          ? (scope as { projectIds?: unknown }).projectIds
          : undefined;
      const raw = entry.entity === 'research-topic' ? nested : doc?.projectIds;
      // Ein eigenes Prädikat statt `Array.isArray`: das verengt ein `unknown`
      // zu `any[]` und würde die unsafe-Findings auf den Elementen zurückholen.
      const arr: unknown[] = isUnknownArray(raw) ? raw : [];
      return {
        projectId: null,
        projectIds: arr.map((p) => idToPlainString(p) ?? '').filter((p) => p !== ''),
      };
    }
    return { projectId: idToPlainString(doc?.projectId) ?? null, projectIds: null };
  }

  private toMs(value: unknown): number | null {
    if (value == null) return null;
    if (value instanceof Date) {
      const t = value.getTime();
      return Number.isNaN(t) ? null : t;
    }
    // Nur String und Number sind sinnvolle Date-Eingaben; alles andere ergäbe
    // ein Invalid Date, das über den NaN-Zweig ohnehin zu null geworden wäre.
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : t;
  }
}
