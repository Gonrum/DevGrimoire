/** Settings keys stored via SettingsService */
export const REPL_ROLE = 'replication.role';
export const REPL_SLAVE_URL = 'replication.slave.url';
export const REPL_SLAVE_API_KEY = 'replication.slave.apiKey';
export const REPL_MASTER_URL = 'replication.master.url';
export const REPL_PEER_URL = 'replication.peer.url';
export const REPL_PEER_API_KEY = 'replication.peer.apiKey';
export const REPL_LAST_SYNC = 'replication.lastSync';
export const REPL_LAST_FULL_SYNC = 'replication.lastFullSync';
export const REPL_LAST_PULL = 'replication.lastPull';
export const REPL_FULL_SYNC_CRON = 'replication.fullSyncCron';
export const REPL_PULL_CRON = 'replication.pullCron';
export const REPL_INSTANCE_ID = 'replication.instanceId';

// --- Fault-tolerant replication engine (Plan 1+) ---
/** Persisted MongoDB change-stream resume token (JSON-stringified). */
export const REPL_WATCHER_RESUME_TOKEN = 'replication.watcher.resumeToken';
/** Highest local log seq the remote has acknowledged (push progress). */
export const REPL_CURSOR_OUTBOUND = 'replication.cursor.outbound';
/** Highest remote log seq received via pull (becomes `since`). */
export const REPL_CURSOR_INBOUND = 'replication.cursor.inbound';
/** 'active' (drives push+pull, e.g. home) | 'passive' (serves endpoints, e.g. office). */
export const REPL_SYNC_DRIVER = 'replication.syncDriver';
/** Sync cycle interval in seconds (default 20). */
export const REPL_SYNC_INTERVAL_SEC = 'replication.syncIntervalSec';
/** Replication-log retention in days (default 14). Must exceed longest offline window. */
export const REPL_LOG_RETENTION_DAYS = 'replication.log.retentionDays';
/** Engine selector: 'legacy' (fire-on-emit) | 'log' (change-stream log). Migration flag. */
export const REPL_ENGINE = 'replication.engine';
/** ISO timestamp of the last completed sync cycle (status/heartbeat). */
export const REPL_LAST_SYNC_CYCLE = 'replication.lastSyncCycle';

/** How many sync cycles an entry may fail to apply (error_transient) before it
 *  is deadlettered and the cursor advances past it (spec §8.2). */
export const MAX_APPLY_ATTEMPTS = 3;

/** Exponential backoff base (ms) per sync direction on a retryable transport error. */
export const REPL_BACKOFF_BASE_MS = 20000;
/** Backoff cap (ms). A terminal error jumps straight to the cap. */
export const REPL_BACKOFF_CAP_MS = 300000;
/** Persisted last-notified direction state (debounce, analog Monitoring). */
export const REPL_OUTBOUND_NOTIFIED_STATE = 'replication.outbound.notifiedState';
export const REPL_INBOUND_NOTIFIED_STATE = 'replication.inbound.notifiedState';
/** ISO timestamp last stamped by the log-writer's change-stream watcher while
 *  its consume loop is alive (§8.3). Goes stale if the watcher dies. */
export const REPL_WATCHER_HEARTBEAT = 'replication.watcher.heartbeat';

export type ReplicationRole = 'standalone' | 'master' | 'slave' | 'peer';

/** Roles that PUSH local changes to a remote (master to slave, peer to peer). */
export const PUSHING_ROLES: ReadonlySet<ReplicationRole> = new Set(['master', 'peer']);

/** Roles that ACCEPT incoming changes (slave from master, peer from peer). */
export const RECEIVING_ROLES: ReadonlySet<ReplicationRole> = new Set(['slave', 'peer']);

export interface ReplicationPayload {
  event: {
    projectId: string | null;
    entity: string;
    action: 'created' | 'updated' | 'deleted';
    entityId: string;
  };
  document: Record<string, unknown> | null;
  attachmentData?: {
    base64: string;
    fileName: string;
    mimeType: string;
    storageKey: string;
  };
  timestamp: string;
  sourceInstanceId: string;
}

export interface ReplicationConfig {
  role: ReplicationRole;
  slaveUrl?: string;
  slaveApiKey?: string;
  masterUrl?: string;
  /** Counterparty URL for peer mode (symmetric bidirectional sync). */
  peerUrl?: string;
  peerApiKey?: string;
  fullSyncCron: string;
  /** Cron schedule for inbound pull (peer mode behind NAT/firewall). */
  pullCron: string;
  instanceId: string;
  /** Active replication engine: 'legacy' (fire-on-emit) | 'log' (change-stream
   *  log). Default 'legacy'; 'log' silences the legacy engine (Plan 4 cutover). */
  engine: 'legacy' | 'log';
}

export interface ReplicationStatus {
  role: string;
  instanceId: string;
  connected: boolean;
  lastSync: string | null;
  lastFullSync: string | null;
  lastPull: string | null;
  queueSize: number;
  failedCount: number;
}

/** Server-side pull response. `until` is the receiver's clock at moment of
 *  response and becomes the next request's `since`. */
export interface ReplicationPullResponse {
  changes: ReplicationPayload[];
  until: string;
  count: number;
}
