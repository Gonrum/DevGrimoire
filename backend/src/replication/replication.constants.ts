/** Settings keys stored via SettingsService */
export const REPL_ROLE = 'replication.role';
export const REPL_SLAVE_URL = 'replication.slave.url';
export const REPL_SLAVE_API_KEY = 'replication.slave.apiKey';
export const REPL_MASTER_URL = 'replication.master.url';
export const REPL_PEER_URL = 'replication.peer.url';
export const REPL_PEER_API_KEY = 'replication.peer.apiKey';
export const REPL_LAST_SYNC = 'replication.lastSync';
export const REPL_LAST_FULL_SYNC = 'replication.lastFullSync';
export const REPL_FULL_SYNC_CRON = 'replication.fullSyncCron';
export const REPL_INSTANCE_ID = 'replication.instanceId';

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
  instanceId: string;
}

export interface ReplicationStatus {
  role: string;
  instanceId: string;
  connected: boolean;
  lastSync: string | null;
  lastFullSync: string | null;
  queueSize: number;
  failedCount: number;
}
