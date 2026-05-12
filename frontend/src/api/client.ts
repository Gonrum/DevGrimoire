const BASE_URL = '/api';

let getAccessToken: (() => string | null) | null = null;
let onUnauthorized: (() => Promise<boolean>) | null = null;

export function configureAuth(
  tokenGetter: () => string | null,
  refreshHandler: () => Promise<boolean>,
) {
  getAccessToken = tokenGetter;
  onUnauthorized = refreshHandler;
}

/**
 * Read-only accessor for components that need to attach the token to a
 * non-fetch transport (e.g. WebSocket query params for the terminal).
 */
export function getCurrentAccessToken(): string | null {
  return getAccessToken?.() ?? null;
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getAccessToken?.();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { ...headers, ...(options?.headers as Record<string, string>) },
  });

  // Auto-refresh on 401
  if (res.status === 401 && onUnauthorized) {
    const refreshed = await onUnauthorized();
    if (refreshed) {
      const newToken = getAccessToken?.();
      if (newToken) headers['Authorization'] = `Bearer ${newToken}`;
      res = await fetch(`${BASE_URL}${path}`, {
        ...options,
        headers: { ...headers, ...(options?.headers as Record<string, string>) },
      });
    }
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || res.statusText);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json();
}

export interface ProjectComponent {
  name: string;
  version: string;
  path?: string;
}

export interface Project {
  _id: string;
  name: string;
  path?: string;
  description?: string;
  techStack: string[];
  repository?: string;
  active: boolean;
  favorite: boolean;
  instructions?: string;
  components: ProjectComponent[];
  todoNumberFormat?: string;
  milestoneNumberFormat?: string;
  gitRepositories?: GitRepository[];
  createdAt: string;
  updatedAt: string;
}

export type CustomerStatus = 'lead' | 'onboarding' | 'active' | 'paused' | 'offboarding' | 'cancelled' | 'archived';

export interface Customer {
  _id: string;
  name: string;
  description?: string;
  status: CustomerStatus;
  tags: string[];
  primaryContactName?: string;
  primaryContactEmail?: string;
  primaryContactPhone?: string;
  website?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export type CustomerProjectLinkStatus = 'active' | 'paused' | 'archived';

export interface CustomerProjectLink {
  _id: string;
  customerId: string;
  projectId: string;
  status: CustomerProjectLinkStatus;
  role?: string;
  notes?: string;
  environmentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  _id: string;
  customerId: string;
  name: string;
  role?: string;
  email?: string;
  phone?: string;
  notes?: string;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type HealthcheckMethod = 'GET' | 'POST' | 'HEAD' | 'PUT' | 'PATCH' | 'DELETE';
export type HealthcheckStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy' | 'paused';

export interface HealthcheckHeader {
  name: string;
  value: string;
}

export interface HealthcheckSecretHeader {
  name: string;
  secretId: string;
}

export interface Healthcheck {
  _id: string;
  customerId: string;
  projectId?: string;
  customerProjectId?: string;
  environmentId?: string;
  name: string;
  description?: string;
  method: HealthcheckMethod;
  url: string;
  headers: HealthcheckHeader[];
  secretHeaders: HealthcheckSecretHeader[];
  body?: string;
  contentType?: string;
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: number[];
  expectedContent?: string;
  failureThreshold: number;
  active: boolean;
  lastStatus: HealthcheckStatus;
  lastRunAt?: string;
  lastLatencyMs?: number;
  lastStatusCode?: number;
  lastError?: string;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HealthcheckHistoryEntry {
  _id: string;
  healthcheckId: string;
  customerId: string;
  runAt: string;
  status: HealthcheckStatus;
  statusCode?: number;
  latencyMs?: number;
  error?: string;
  createdAt: string;
}

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

export interface ChangelogEntry {
  _id: string;
  projectId: string;
  version?: string;
  changes: string[];
  summary?: string;
  component?: string;
  repoLabel?: string;
  createdAt: string;
  updatedAt: string;
}

export type BackupMode = 'database' | 'full-system';
export type BackupStatus = 'running' | 'completed' | 'failed';

export interface BackupArtifact {
  key: string;
  size: number;
  sha256: string;
  contentType: string;
}

export interface BackupManifest {
  format?: string;
  mode?: BackupMode;
  trigger?: 'manual' | 'scheduled';
  startedAt?: string;
  finishedAt?: string;
  bucket?: string;
  objectPrefix?: string;
  includes?: {
    database?: boolean;
    attachments?: boolean;
    plaintextSecrets?: boolean;
  };
  artifacts?: BackupArtifact[];
  restore?: { note?: string };
}

export type CustomerTemplateType =
  | 'onboarding'
  | 'todo_list'
  | 'monitoring'
  | 'environment'
  | 'workflow'
  | 'contact_type';

export type CustomerTemplateItemKind =
  | 'todo'
  | 'monitoring_check'
  | 'environment'
  | 'workflow'
  | 'contact_type'
  | 'note';

export interface CustomerTemplateItem {
  kind: CustomerTemplateItemKind;
  title: string;
  description?: string;
  payload: Record<string, unknown>;
  requiredSecretKeys?: string[];
  placeholders?: Record<string, string>;
}

export interface CustomerTemplate {
  _id: string;
  name: string;
  slug: string;
  description?: string;
  type: CustomerTemplateType;
  active: boolean;
  version: number;
  tags: string[];
  items: CustomerTemplateItem[];
  createdAt: string;
  updatedAt: string;
}

export interface CustomerTemplatePreview {
  template: { id: string; name: string; type: string; version: number };
  items: Array<{
    kind: CustomerTemplateItemKind;
    title: string;
    description?: string;
    payload: Record<string, unknown>;
  }>;
  requiredSecretKeys: string[];
}

export interface CustomerTemplateApplyResult {
  templateId: string;
  templateVersion: number;
  customerId: string;
  appliedAt: string;
  created: Array<{
    kind: CustomerTemplateItemKind;
    id?: string;
    title: string;
    note?: string;
  }>;
  missingSecretKeys: string[];
}

export interface BackupJob {
  _id: string;
  mode: BackupMode;
  status: BackupStatus;
  trigger: 'manual' | 'scheduled';
  bucket?: string;
  objectPrefix?: string;
  manifest?: BackupManifest;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackupRetentionPolicy {
  keepLast: number;
  keepDays: number;
}

export interface BackupRetentionPreview {
  dryRun: boolean;
  policy: BackupRetentionPolicy;
  deleteJobCount: number;
  deleteObjectCount: number;
  deletedObjectCount?: number;
  candidates: Array<{
    jobId: string;
    createdAt?: string;
    bucket: string;
    objectPrefix?: string;
    artifactKeys: string[];
    status: BackupStatus;
  }>;
  errors?: Array<{ jobId: string; message: string }>;
  ok?: boolean;
  note: string;
}

export interface BackupRestorePreview {
  jobId: string;
  status: BackupStatus;
  bucket: string;
  objectPrefix: string;
  manifestKey: string;
  manifestFormat?: string | null;
  includes: BackupManifest['includes'];
  artifactCount: number;
  checks: Array<{
    key: string;
    exists: boolean;
    size?: number;
    expectedSize?: number;
    sizeMatches: boolean;
    sha256Matches: boolean;
    contentType?: string;
    error?: string;
  }>;
  ok: boolean;
  note: string;
}

export interface BackupSystemStatus {
  enabled: boolean;
  schedule: string;
  bucket: string;
  minioEnabled: boolean;
  running: boolean;
  retention?: BackupRetentionPolicy;
}

export interface TodoComment {
  text: string;
  author: string;
  createdAt: string;
}

export interface Todo {
  _id: string;
  projectId?: string;
  customerId?: string;
  title: string;
  description?: string;
  status: 'open' | 'in_progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];
  milestoneId?: string;
  blockedBy: string[];
  repoLabel?: string;
  archived: boolean;
  comments: TodoComment[];
  number?: number;
  displayNumber?: string;
  createdAt: string;
  updatedAt: string;
}

export type ValidationReportStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface ValidationReport {
  _id: string;
  projectId: string;
  todoId?: string;
  commitId?: string;
  workflowRunId?: string;
  name: string;
  command?: string;
  status: ValidationReportStatus;
  exitCode?: number;
  durationMs?: number;
  truncated: boolean;
  summary?: string;
  outputSnippet?: string;
  tags: string[];
  metadata?: Record<string, unknown> & { bugTodoId?: string; bugTodoCreatedAt?: string };
  createdAt: string;
  updatedAt: string;
}

export type DocProposalStatus =
  | 'open'
  | 'accepted'
  | 'edited'
  | 'converted_to_todo'
  | 'dismissed'
  | 'superseded';

export type DocProposalSourceType = 'todo' | 'commit' | 'release' | 'workflow_run' | 'manual';
export type DocProposalTargetType = 'doc_file' | 'knowledge' | 'manual';
export type DocProposalChangeMode = 'patch' | 'instructions' | 'new_section' | 'review_only';

export interface DocUpdateProposal {
  _id: string;
  projectId: string;
  status: DocProposalStatus;
  source: {
    type: DocProposalSourceType;
    id: string;
    title?: string;
    summary: string;
    changedFiles?: string[];
    tags?: string[];
  };
  target: {
    type: DocProposalTargetType;
    id?: string;
    path?: string;
    title: string;
  };
  reason: string;
  confidence: number;
  suggestedChange: {
    mode: DocProposalChangeMode;
    summary: string;
    diff?: string;
    instructions?: string;
  };
  safety: {
    containsSecretValues: boolean;
    requiresHumanReview: boolean;
    destructive: boolean;
  };
  createdBy: 'system' | 'agent' | 'user';
  metadata?: Record<string, unknown> & { todoId?: string; todoCreatedAt?: string; statusNote?: string };
  createdAt: string;
  updatedAt: string;
}

export type KgEntityType =
  | 'todo'
  | 'milestone'
  | 'knowledge'
  | 'manual'
  | 'research'
  | 'schema'
  | 'feature'
  | 'dependency'
  | 'changelog'
  | 'workflow'
  | 'release'
  | 'snippet'
  | 'commit'
  | 'validation_report'
  | 'doc_update_proposal'
  | 'session';

export type KgRelation =
  | 'belongs_to'
  | 'completed_by'
  | 'blocked_by'
  | 'tagged_overlap'
  | 'category_match'
  | 'validates'
  | 'documents'
  | 'depends_on'
  | 'mentions'
  | 'proposes_update'
  | 'references';

export interface KgEndpoint {
  entityType: KgEntityType;
  entityId: string;
  label?: string;
}

export interface KnowledgeGraphEdge {
  _id: string;
  projectId: string;
  source: KgEndpoint;
  target: KgEndpoint;
  relation: KgRelation;
  weight: number;
  confidence: number;
  direction: 'directed' | 'undirected';
  createdBy: 'system' | 'agent' | 'user';
  userConfirmed: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeGraphImpact {
  focal: { entityType: KgEntityType; entityId: string };
  reachable: Array<{ entityType: KgEntityType; entityId: string; label?: string; depth: number }>;
  edges: KnowledgeGraphEdge[];
}

export type OracleRiskType = 'stagnation' | 'deadline_pressure' | 'bug_hotspot' | 'blocker_chain';
export type OracleSeverity = 'info' | 'warn' | 'critical';
export type OracleSuggestionStatus = 'open' | 'dismissed' | 'converted_to_todo' | 'addressed';

export interface OracleAffectedEntity {
  entityType: KgEntityType;
  entityId: string;
  label?: string;
}

export interface OracleSuggestion {
  _id: string;
  projectId: string;
  type: OracleRiskType;
  severity: OracleSeverity;
  status: OracleSuggestionStatus;
  title: string;
  reason: string;
  recommendedAction?: string;
  affectedEntities: OracleAffectedEntity[];
  fingerprint: string;
  expiresAt?: string;
  metadata?: Record<string, unknown> & { todoId?: string; todoCreatedAt?: string; statusNote?: string };
  createdAt: string;
  updatedAt: string;
}

export interface OracleAnalyzeResult {
  discovered: number;
  inserted: number;
  refreshed: number;
  resolved: number;
}

export interface Milestone {
  _id: string;
  projectId: string;
  name: string;
  description?: string;
  status: 'open' | 'in_progress' | 'done';
  dueDate?: string;
  archived: boolean;
  changelogId?: string;
  number?: number;
  displayNumber?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  _id: string;
  projectId: string;
  summary: string;
  filesChanged: string[];
  nextSteps: string[];
  openQuestions: string[];
  createdAt: string;
}

export interface Knowledge {
  _id: string;
  projectId?: string;
  customerId?: string;
  scope?: 'global' | 'project' | 'customer';
  topic: string;
  content: string;
  tags: string[];
  category?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  _id: string;
  projectId?: string;
  customerId?: string;
  entity: string;
  action: string;
  entityId?: string;
  summary?: string;
  userId?: string;
  username?: string;
  createdAt: string;
}

export interface EnvVariable {
  key: string;
  value: string;
}

export interface Environment {
  _id: string;
  projectId?: string;
  customerId?: string;
  name: string;
  description?: string;
  host?: string;
  port?: number;
  user?: string;
  url?: string;
  variables: EnvVariable[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Manual {
  _id: string;
  projectId?: string;
  customerId?: string;
  title: string;
  content: string;
  category?: string;
  sortOrder: number;
  lastEditedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchEntry {
  _id: string;
  projectId?: string;
  customerId?: string;
  title: string;
  content: string;
  sources: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export type SecretType = 'variable' | 'password' | 'token' | 'ssh_key' | 'certificate' | 'file';

export interface SecretListItem {
  _id: string;
  projectId: string | null;
  customerId: string | null;
  environmentId: string | null;
  key: string;
  description?: string;
  type: SecretType;
  createdAt: string;
  updatedAt: string;
}

export interface SecretWithValue extends SecretListItem {
  value: string;
}

export interface Notification {
  _id: string;
  title: string;
  body: string;
  url?: string;
  read: boolean;
  createdAt: string;
}

export type LlmMode = 'server' | 'browser';

export interface UserLlmConfig {
  mode?: LlmMode;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  fallbackEnabled?: boolean;
}

export interface UserInfo {
  _id: string;
  username: string;
  email?: string;
  role: 'admin' | 'user';
  active: boolean;
  llmConfig?: UserLlmConfig;
  permissions?: string[];
  projectScopeMode?: 'all' | 'allowlist' | 'none';
  allowedProjectIds?: string[];
  customerScopeMode?: 'all' | 'allowlist' | 'none';
  allowedCustomerIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export type ScopeMode = 'all' | 'allowlist' | 'none';

export interface ApiKeyInfo {
  _id: string;
  prefix: string;
  name: string;
  lastUsedAt?: string;
  expiresAt?: string;
  active: boolean;
  allowedTools?: string[];
  permissions?: string[];
  projectScopeMode?: ScopeMode;
  allowedProjectIds?: string[];
  customerScopeMode?: ScopeMode;
  allowedCustomerIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyCreateResponse extends ApiKeyInfo {
  key: string;
}

export interface ApiKeyCreatePayload {
  name: string;
  expiresAt?: string;
  allowedTools?: string[];
  permissions?: string[];
  projectScopeMode?: ScopeMode;
  allowedProjectIds?: string[];
  customerScopeMode?: ScopeMode;
  allowedCustomerIds?: string[];
}

export interface ApiKeyUpdatePayload {
  name?: string;
  allowedTools?: string[] | null;
  permissions?: string[];
  projectScopeMode?: ScopeMode;
  allowedProjectIds?: string[];
  customerScopeMode?: ScopeMode;
  allowedCustomerIds?: string[];
}

export interface SearchResult {
  type: 'todo' | 'knowledge' | 'changelog' | 'research' | 'milestone';
  id: string;
  projectId: string;
  title: string;
  snippet: string;
  status?: string;
  priority?: string;
}

export interface SchemaField {
  name: string;
  type: string;
  nullable?: boolean;
  defaultValue?: string;
  description?: string;
  isPrimaryKey?: boolean;
  isIndexed?: boolean;
  reference?: string;
}

export interface SchemaIndex {
  name: string;
  fields: string[];
  unique?: boolean;
  type?: string;
}

export type DbType = 'mssql' | 'mysql' | 'mongodb' | 'postgresql';

export interface SchemaObject {
  _id: string;
  projectId: string;
  name: string;
  dbType: DbType;
  database?: string;
  description?: string;
  fields: SchemaField[];
  indexes: SchemaIndex[];
  version: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SchemaVersion {
  _id: string;
  schemaId: string;
  version: number;
  fields: SchemaField[];
  indexes: SchemaIndex[];
  changeNote?: string;
  createdAt: string;
}

export type PackageManager = 'npm' | 'composer' | 'pip' | 'cargo' | 'go' | 'maven' | 'nuget' | 'gem';

export interface Dependency {
  _id: string;
  projectId: string;
  name: string;
  version: string;
  description?: string;
  packageManager: PackageManager;
  devDependency: boolean;
  category?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Soul {
  _id: string;
  projectId?: string;
  customerId?: string;
  vision: string;
  principles: string;
  conventions: string;
  communication: string;
  boundaries: string;
  workflow: string;
  quality: string;
  createdAt: string;
  updatedAt: string;
}

export type FeatureStatus = 'planned' | 'in_development' | 'released' | 'deprecated';
export type FeaturePriority = 'low' | 'medium' | 'high';

export interface Feature {
  _id: string;
  projectId: string;
  name: string;
  description?: string;
  category?: string;
  status: FeatureStatus;
  version?: string;
  priority?: FeaturePriority;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceStatus = 'active' | 'archived' | 'cleaning';

export type WorkspaceStreamEvent =
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; line: string }
  | { type: 'truncated'; stream: 'stdout' | 'stderr' }
  | { type: 'error'; message: string }
  | {
      type: 'done';
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      killReason: string | null;
      durationMs: number;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      stdoutBytes: number;
      stderrBytes: number;
    }
  | { type: 'cwd'; cwd: string };

export interface Workspace {
  _id: string;
  projectId: string;
  name: string;
  description?: string;
  repoUrl?: string;
  branch: string;
  path: string;
  status: WorkspaceStatus;
  sizeBytes: number;
  lastActivityAt: string;
  createdBySessionId?: string;
  gitRepoId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Snippet {
  _id: string;
  projectId?: string;
  customerId?: string;
  title: string;
  language: string;
  code: string;
  description?: string;
  tags: string[];
  category?: string;
  fileName?: string;
  createdAt: string;
  updatedAt: string;
}

export type RecurringFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';

export type RecurringAction = 'todo' | 'chat';
export type RecurringRunStatus = 'pending' | 'succeeded' | 'failed';

export interface RecurringChatConfig {
  prompt: string;
  systemPrompt?: string;
  allowedTools?: string[];
  agentRoleId?: string;
  timeoutMs?: number;
  maxToolIterations?: number;
  sessionStrategy?: 'new' | 'reuse';
}

export interface RecurringTask {
  _id: string;
  projectId?: string;
  customerId?: string;
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];
  milestoneId?: string;
  repoLabel?: string;
  frequency: RecurringFrequency;
  dayOfWeek?: number;
  dayOfMonth?: number;
  month?: number;
  hour: number;
  active: boolean;
  lastRun?: string;
  nextRun: string;
  createdTodoIds: string[];
  maxCatchUp: number;
  action?: RecurringAction;
  chat?: RecurringChatConfig;
  createdByUserId?: string;
  chatSessionIds?: string[];
  lastRunStatus?: RecurringRunStatus;
  lastRunError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitRepository {
  _id?: string;
  provider: 'github' | 'gitlab';
  label?: string;
  baseUrl?: string;
  owner?: string;
  repo?: string;
  gitlabProjectId?: string;
  defaultBranch?: string;
  tokenSecretId?: string;
  syncEnabled?: boolean;
  lastSyncAt?: string;
  lastSyncSha?: string;
}

export interface CommitEntry {
  _id: string;
  projectId: string;
  provider: 'github' | 'gitlab';
  sha: string;
  message: string;
  authorName: string;
  authorEmail?: string;
  committedAt: string;
  url?: string;
  branch?: string;
  repoIndex?: number;
  repoLabel?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  createdAt: string;
}

export interface LogEntry {
  _id: string;
  projectId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  service?: string;
  area?: string;
  environment?: string;
  metadata?: Record<string, unknown>;
  tags: string[];
  source?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface LogStats {
  total: number;
  byLevel: Record<string, number>;
  byService: { service: string; count: number }[];
  oldestEntry: string | null;
  newestEntry: string | null;
}

export interface Attachment {
  _id: string;
  projectId?: string;
  customerId?: string;
  entityType?: string;
  entityId?: string;
  originalName: string;
  mimeType: string;
  size: number;
  storageKey: string;
  description?: string;
  tags: string[];
  ragIndexed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReplicationConfig {
  role: 'standalone' | 'master' | 'slave' | 'peer';
  slaveUrl?: string;
  slaveApiKey?: string;
  masterUrl?: string;
  /** Counterparty URL when role=peer (symmetric bidirectional sync). */
  peerUrl?: string;
  peerApiKey?: string;
  fullSyncCron: string;
  /** Cron schedule for inbound pull when behind NAT (peer mode). */
  pullCron?: string;
  instanceId: string;
}

export interface ReplicationProjectEntry {
  _id: string;
  name: string;
  active: boolean;
  favorite: boolean;
  replicationEnabled: boolean;
}

export interface RemoteProjectEntry {
  _id: string;
  name: string;
  active: boolean;
  favorite: boolean;
  remoteReplicationEnabled: boolean;
  existsLocally: boolean;
  localReplicationEnabled: boolean;
}

export interface ReplicationStatus {
  role: string;
  instanceId: string;
  connected: boolean;
  lastSync: string | null;
  lastFullSync: string | null;
  /** Last successful pull from peer (only relevant in peer role). */
  lastPull: string | null;
  queueSize: number;
  failedCount: number;
}

export type ReleaseType = 'manual' | 'gitlab';
export type ReleasePlatform = 'android' | 'ios' | 'web' | 'desktop' | 'docker' | 'other';
export type ReleaseStatus = 'draft' | 'published' | 'archived';

export interface ReleaseAsset {
  name: string;
  url: string;
  size?: number;
  format?: string;
}

export interface Release {
  _id: string;
  projectId: string;
  version: string;
  title?: string;
  description?: string;
  releaseType: ReleaseType;
  platform: ReleasePlatform;
  status: ReleaseStatus;
  downloadUrl?: string;
  gitlabReleaseId?: string;
  gitlabTagName?: string;
  assets: ReleaseAsset[];
  tags: string[];
  repoLabel?: string;
  createdAt: string;
  updatedAt: string;
}

export const api = {
  projects: {
    list: (filters?: { active?: boolean; favorite?: boolean; customerId?: string }) => {
      const params = new URLSearchParams();
      if (filters?.active !== undefined) params.set('active', String(filters.active));
      if (filters?.favorite !== undefined) params.set('favorite', String(filters.favorite));
      if (filters?.customerId) params.set('customerId', filters.customerId);
      const qs = params.toString();
      return request<Project[]>(`/projects${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<Project>(`/projects/${id}`),
    create: (data: Partial<Project>) =>
      request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Project>) =>
      request<Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/projects/${id}`, { method: 'DELETE' }),
  },
  customers: {
    dashboard: () =>
      request<{
        summary: {
          totalActive: number;
          withOpenTodos: number;
          withoutProjects: number;
          recentlyUpdated: number;
        };
        customers: Array<{
          customerId: string;
          name: string;
          status: string;
          openTodoCount: number;
          projectCount: number;
          lastActivityAt: string;
        }>;
      }>('/customers/dashboard'),
    list: (filters?: {
      status?: CustomerStatus;
      tag?: string;
      q?: string;
      includeArchived?: boolean;
      projectId?: string;
    }) => {
      const params = new URLSearchParams();
      if (filters?.status) params.set('status', filters.status);
      if (filters?.tag) params.set('tag', filters.tag);
      if (filters?.q) params.set('q', filters.q);
      if (filters?.includeArchived !== undefined) {
        params.set('includeArchived', String(filters.includeArchived));
      }
      if (filters?.projectId) params.set('projectId', filters.projectId);
      const qs = params.toString();
      return request<Customer[]>(`/customers${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<Customer>(`/customers/${id}`),
    create: (data: Partial<Customer>) =>
      request<Customer>('/customers', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Customer>) =>
      request<Customer>(`/customers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    archive: (id: string) =>
      request<Customer>(`/customers/${id}`, { method: 'DELETE' }),
    listProjectLinks: (customerId: string) =>
      request<CustomerProjectLink[]>(`/customers/${customerId}/project-links`),
    listProjectCustomerLinks: (projectId: string) =>
      request<CustomerProjectLink[]>(`/customers/by-project/${projectId}/links`),
    createProjectLink: (customerId: string, data: Partial<CustomerProjectLink>) =>
      request<CustomerProjectLink>(`/customers/${customerId}/project-links`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateProjectLink: (
      customerId: string,
      linkId: string,
      data: Partial<CustomerProjectLink>,
    ) =>
      request<CustomerProjectLink>(`/customers/${customerId}/project-links/${linkId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    deleteProjectLink: (customerId: string, linkId: string) =>
      request<void>(`/customers/${customerId}/project-links/${linkId}`, {
        method: 'DELETE',
      }),
  },
  monitoring: {
    list: (customerId: string) =>
      request<Healthcheck[]>(`/customers/${customerId}/healthchecks`),
    summary: (customerId: string) =>
      request<CustomerHealthSummary>(`/customers/${customerId}/healthchecks/summary`),
    create: (customerId: string, data: Partial<Healthcheck>) =>
      request<Healthcheck>(`/customers/${customerId}/healthchecks`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    get: (id: string) => request<Healthcheck>(`/healthchecks/${id}`),
    update: (id: string, data: Partial<Healthcheck>) =>
      request<Healthcheck>(`/healthchecks/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    remove: (id: string) =>
      request<void>(`/healthchecks/${id}`, { method: 'DELETE' }),
    run: (id: string) =>
      request<Healthcheck>(`/healthchecks/${id}/run`, { method: 'POST' }),
    history: (id: string, limit = 50, offset = 0) =>
      request<HealthcheckHistoryEntry[]>(
        `/healthchecks/${id}/history?limit=${limit}&offset=${offset}`,
      ),
  },
  contacts: {
    list: (customerId: string) =>
      request<Contact[]>(`/customers/${customerId}/contacts`),
    get: (customerId: string, contactId: string) =>
      request<Contact>(`/customers/${customerId}/contacts/${contactId}`),
    create: (customerId: string, data: Partial<Contact>) =>
      request<Contact>(`/customers/${customerId}/contacts`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (customerId: string, contactId: string, data: Partial<Contact>) =>
      request<Contact>(`/customers/${customerId}/contacts/${contactId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    remove: (customerId: string, contactId: string) =>
      request<void>(`/customers/${customerId}/contacts/${contactId}`, {
        method: 'DELETE',
      }),
  },
  todos: {
    list: (filters?: { projectId?: string; customerId?: string; status?: string }) => {
      const params = new URLSearchParams();
      if (filters?.projectId) params.set('projectId', filters.projectId);
      if (filters?.customerId) params.set('customerId', filters.customerId);
      if (filters?.status) params.set('status', filters.status);
      const qs = params.toString();
      return request<Todo[]>(`/todos${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<Todo>(`/todos/${id}`),
    create: (data: Partial<Todo>) =>
      request<Todo>('/todos', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Todo>) =>
      request<Todo>(`/todos/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/todos/${id}`, { method: 'DELETE' }),
    addComment: (id: string, text: string, author?: string) =>
      request<Todo>(`/todos/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ text, author }),
      }),
  },
  sessions: {
    list: (projectId: string, limit?: number) => {
      const params = new URLSearchParams({ projectId });
      if (limit) params.set('limit', String(limit));
      return request<Session[]>(`/sessions?${params}`);
    },
    latest: (projectId: string) =>
      request<Session | null>(`/sessions/latest/${projectId}`),
    create: (data: Partial<Session>) =>
      request<Session>('/sessions', { method: 'POST', body: JSON.stringify(data) }),
  },
  knowledge: {
    list: (projectId: string | undefined, options?: { customerId?: string; scope?: string }) => {
      const params = new URLSearchParams();
      if (projectId) params.set('projectId', projectId);
      if (options?.customerId) params.set('customerId', options.customerId);
      if (options?.scope) params.set('scope', options.scope);
      return request<Knowledge[]>(`/knowledge?${params}`);
    },
    listForCustomer: (customerId: string) =>
      request<Knowledge[]>(`/knowledge?customerId=${customerId}`),
    search: (query: string, projectId?: string, options?: { customerId?: string; scope?: string }) => {
      const params = new URLSearchParams({ q: query });
      if (projectId) params.set('projectId', projectId);
      if (options?.customerId) params.set('customerId', options.customerId);
      if (options?.scope) params.set('scope', options.scope);
      return request<Knowledge[]>(`/knowledge/search?${params}`);
    },
    get: (id: string) => request<Knowledge>(`/knowledge/${id}`),
    create: (data: Partial<Knowledge>) =>
      request<Knowledge>('/knowledge', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Knowledge>) =>
      request<Knowledge>(`/knowledge/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/knowledge/${id}`, { method: 'DELETE' }),
  },
  changelog: {
    list: (projectId: string, limit?: number) => {
      const params = new URLSearchParams({ projectId });
      if (limit) params.set('limit', String(limit));
      return request<ChangelogEntry[]>(`/changelog?${params}`);
    },
    get: (id: string) => request<ChangelogEntry>(`/changelog/${id}`),
    create: (data: Partial<ChangelogEntry>) =>
      request<ChangelogEntry>('/changelog', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<ChangelogEntry>) =>
      request<ChangelogEntry>(`/changelog/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/changelog/${id}`, { method: 'DELETE' }),
  },
  push: {
    getVapidKey: () => request<{ publicKey: string }>('/push/vapid-public-key'),
    subscribe: (subscription: PushSubscriptionJSON) =>
      request<{ ok: boolean }>('/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) }),
    unsubscribe: (endpoint: string) =>
      request<{ ok: boolean }>('/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) }),
  },
  activities: {
    list: (projectId: string, limit?: number) => {
      const params = new URLSearchParams({ projectId });
      if (limit) params.set('limit', String(limit));
      return request<Activity[]>(`/activities?${params}`);
    },
    listForCustomer: (customerId: string, limit?: number) => {
      const params = new URLSearchParams({ customerId });
      if (limit) params.set('limit', String(limit));
      return request<Activity[]>(`/activities?${params}`);
    },
  },
  milestones: {
    list: (projectId: string, status?: string) => {
      const params = new URLSearchParams({ projectId });
      if (status) params.set('status', status);
      return request<Milestone[]>(`/milestones?${params}`);
    },
    get: (id: string) => request<Milestone>(`/milestones/${id}`),
    create: (data: Partial<Milestone>) =>
      request<Milestone>('/milestones', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Milestone>) =>
      request<Milestone>(`/milestones/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/milestones/${id}`, { method: 'DELETE' }),
  },
  environments: {
    list: (projectId: string) =>
      request<Environment[]>(`/environments?projectId=${projectId}`),
    listForCustomer: (customerId: string) =>
      request<Environment[]>(`/environments?customerId=${customerId}`),
    get: (id: string) => request<Environment>(`/environments/${id}`),
    create: (data: Partial<Environment>) =>
      request<Environment>('/environments', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Environment>) =>
      request<Environment>(`/environments/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/environments/${id}`, { method: 'DELETE' }),
  },
  secrets: {
    list: (projectId: string, environmentId?: string) => {
      const params = new URLSearchParams({ projectId });
      if (environmentId !== undefined) params.set('environmentId', environmentId);
      return request<SecretListItem[]>(`/secrets?${params}`);
    },
    listForCustomer: (customerId: string, environmentId?: string) => {
      const params = new URLSearchParams({ customerId });
      if (environmentId !== undefined) params.set('environmentId', environmentId);
      return request<SecretListItem[]>(`/secrets?${params}`);
    },
    get: (id: string) => request<SecretWithValue>(`/secrets/${id}`),
    create: (data: { projectId?: string; customerId?: string; environmentId?: string; key: string; value: string; description?: string; type?: SecretType }) =>
      request<SecretListItem>('/secrets', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { key?: string; value?: string; description?: string; type?: SecretType }) =>
      request<SecretListItem>(`/secrets/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/secrets/${id}`, { method: 'DELETE' }),
  },
  manuals: {
    list: (projectId: string, category?: string) => {
      const params = new URLSearchParams({ projectId });
      if (category) params.set('category', category);
      return request<Manual[]>(`/manuals?${params}`);
    },
    listForCustomer: (customerId: string, category?: string) => {
      const params = new URLSearchParams({ customerId });
      if (category) params.set('category', category);
      return request<Manual[]>(`/manuals?${params}`);
    },
    get: (id: string) => request<Manual>(`/manuals/${id}`),
    create: (data: Partial<Manual>) =>
      request<Manual>('/manuals', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Manual>) =>
      request<Manual>(`/manuals/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/manuals/${id}`, { method: 'DELETE' }),
  },
  notifications: {
    list: (limit?: number, unreadOnly?: boolean) => {
      const params = new URLSearchParams();
      if (limit) params.set('limit', String(limit));
      if (unreadOnly) params.set('unreadOnly', 'true');
      return request<Notification[]>(`/notifications?${params}`);
    },
    unreadCount: () =>
      request<{ count: number }>('/notifications/unread-count'),
    markAsRead: (id: string) =>
      request<Notification>(`/notifications/${id}/read`, { method: 'PUT' }),
    markAllAsRead: () =>
      request<void>('/notifications/read-all', { method: 'PUT' }),
    delete: (id: string) =>
      request<void>(`/notifications/${id}`, { method: 'DELETE' }),
    deleteAll: () =>
      request<{ deleted: number }>('/notifications/all', { method: 'DELETE' }),
  },
  questions: {
    pending: (direction?: QuestionDirection) => {
      const qs = direction ? `?direction=${direction}` : '';
      return request<Question[]>(`/questions/pending${qs}`);
    },
    open: (params: { projectId?: string; direction?: QuestionDirection; limit?: number; offset?: number } = {}) => {
      const qs = new URLSearchParams();
      if (params.projectId) qs.set('projectId', params.projectId);
      if (params.direction) qs.set('direction', params.direction);
      if (params.limit !== undefined) qs.set('limit', String(params.limit));
      if (params.offset !== undefined) qs.set('offset', String(params.offset));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return request<{ items: Question[]; total: number }>(`/questions/open${suffix}`);
    },
    byTodo: (todoId: string, includeAnswered = true) =>
      request<Question[]>(`/questions/by-todo/${todoId}?includeAnswered=${includeAnswered}`),
    byTodos: (todoIds: string[]) => {
      if (todoIds.length === 0) return Promise.resolve({} as Record<string, QuestionsByTodoSummary>);
      return request<Record<string, QuestionsByTodoSummary>>(
        `/questions/by-todos?ids=${encodeURIComponent(todoIds.join(','))}`,
      );
    },
    answer: (id: string, answer: string) =>
      request<Question>(`/questions/${id}/answer`, {
        method: 'POST',
        body: JSON.stringify({ answer }),
      }),
    createUserToAgent: (data: {
      question: string;
      todoId?: string;
      projectId?: string;
      context?: string;
      options?: string[];
    }) =>
      request<Question>(`/questions/user-to-agent`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
  settings: {
    get: (key: string) =>
      request<{ key: string; value: string | null }>(`/settings/${key}`),
    set: (key: string, value: string) =>
      request<{ key: string; value: string }>(`/settings/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      }),
  },
  backups: {
    status: () => request<BackupSystemStatus>('/backups/status'),
    list: (limit = 25) => request<BackupJob[]>(`/backups?limit=${limit}`),
    get: (id: string) => request<BackupJob>(`/backups/${id}`),
    retentionPreview: () => request<BackupRetentionPreview>('/backups/retention/preview'),
    applyRetention: (confirm: string) =>
      request<BackupRetentionPreview>('/backups/retention/apply', { method: 'POST', body: JSON.stringify({ confirm }) }),
    restorePreview: (id: string) => request<BackupRestorePreview>(`/backups/${id}/restore-preview`),
    create: (data?: { mode?: BackupMode; includeAttachments?: boolean }) =>
      request<BackupJob>('/backups', { method: 'POST', body: JSON.stringify(data ?? {}) }),
  },
  webSearch: {
    health: () =>
      request<{ enabled: boolean; searxng: { ok: boolean; url: string; error?: string } }>(
        '/web-search/health',
      ),
    stats: () =>
      request<{
        search: { cached: number; oldestEntry?: string };
        fetch: { cached: number; oldestEntry?: string };
      }>('/web-search/stats'),
    clearCache: () =>
      request<{ search: { deleted: number }; fetch: { deleted: number } }>(
        '/web-search/cache/clear',
        { method: 'POST' },
      ),
  },
  research: {
    list: (projectId: string) =>
      request<ResearchEntry[]>(`/research?projectId=${projectId}`),
    listForCustomer: (customerId: string) =>
      request<ResearchEntry[]>(`/research?customerId=${customerId}`),
    get: (id: string) => request<ResearchEntry>(`/research/${id}`),
    create: (data: Partial<ResearchEntry>) =>
      request<ResearchEntry>('/research', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<ResearchEntry>) =>
      request<ResearchEntry>(`/research/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/research/${id}`, { method: 'DELETE' }),
  },
  search: {
    query: (q: string, projectId?: string, limit?: number) => {
      const params = new URLSearchParams({ q });
      if (projectId) params.set('projectId', projectId);
      if (limit) params.set('limit', String(limit));
      return request<SearchResult[]>(`/search?${params}`);
    },
  },
  users: {
    list: () => request<UserInfo[]>('/users'),
    get: (id: string) => request<UserInfo>(`/users/${id}`),
    create: (data: { username: string; email?: string; password: string; role?: string }) =>
      request<UserInfo>('/users', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<UserInfo>) =>
      request<UserInfo>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/users/${id}`, { method: 'DELETE' }),
  },
  apiKeys: {
    list: () => request<ApiKeyInfo[]>('/api-keys'),
    create: (data: ApiKeyCreatePayload) =>
      request<ApiKeyCreateResponse>('/api-keys', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: ApiKeyUpdatePayload) =>
      request<ApiKeyInfo>(`/api-keys/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/api-keys/${id}`, { method: 'DELETE' }),
  },
  mcp: {
    tools: () =>
      request<{ name: string; description: string; group: string; isWrite: boolean }[]>('/mcp/tools'),
  },
  schemas: {
    list: (projectId: string, dbType?: string) => {
      const params = new URLSearchParams({ projectId });
      if (dbType) params.set('dbType', dbType);
      return request<SchemaObject[]>(`/schemas?${params}`);
    },
    get: (id: string) => request<SchemaObject>(`/schemas/${id}`),
    create: (data: Partial<SchemaObject>) =>
      request<SchemaObject>('/schemas', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<SchemaObject> & { changeNote?: string }) =>
      request<SchemaObject>(`/schemas/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/schemas/${id}`, { method: 'DELETE' }),
    versions: (id: string) => request<SchemaVersion[]>(`/schemas/${id}/versions`),
  },
  features: {
    list: (projectId: string, filters?: { status?: FeatureStatus; category?: string }) => {
      const params = new URLSearchParams({ projectId });
      if (filters?.status) params.set('status', filters.status);
      if (filters?.category) params.set('category', filters.category);
      return request<Feature[]>(`/features?${params}`);
    },
    get: (id: string) => request<Feature>(`/features/${id}`),
    create: (data: Partial<Feature>) =>
      request<Feature>('/features', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Feature>) =>
      request<Feature>(`/features/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/features/${id}`, { method: 'DELETE' }),
  },
  dependencies: {
    list: (projectId: string, filters?: { packageManager?: PackageManager; category?: string; devDependency?: boolean }) => {
      const params = new URLSearchParams({ projectId });
      if (filters?.packageManager) params.set('packageManager', filters.packageManager);
      if (filters?.category) params.set('category', filters.category);
      if (filters?.devDependency !== undefined) params.set('devDependency', String(filters.devDependency));
      return request<Dependency[]>(`/dependencies?${params}`);
    },
    get: (id: string) => request<Dependency>(`/dependencies/${id}`),
    create: (data: Partial<Dependency>) =>
      request<Dependency>('/dependencies', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Dependency>) =>
      request<Dependency>(`/dependencies/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/dependencies/${id}`, { method: 'DELETE' }),
  },
  commits: {
    list: (projectId: string, filters?: { branch?: string; author?: string; since?: string; until?: string; provider?: string; repoLabel?: string; limit?: number; offset?: number }) => {
      const params = new URLSearchParams({ projectId });
      if (filters?.branch) params.set('branch', filters.branch);
      if (filters?.author) params.set('author', filters.author);
      if (filters?.since) params.set('since', filters.since);
      if (filters?.until) params.set('until', filters.until);
      if (filters?.provider) params.set('provider', filters.provider);
      if (filters?.repoLabel) params.set('repoLabel', filters.repoLabel);
      if (filters?.limit) params.set('limit', String(filters.limit));
      if (filters?.offset) params.set('offset', String(filters.offset));
      return request<CommitEntry[]>(`/commits?${params}`);
    },
    search: (projectId: string, query: string, limit?: number) => {
      const params = new URLSearchParams({ projectId, q: query });
      if (limit) params.set('limit', String(limit));
      return request<CommitEntry[]>(`/commits/search?${params}`);
    },
    count: (projectId: string, repoLabel?: string) => {
      const params = new URLSearchParams({ projectId });
      if (repoLabel) params.set('repoLabel', repoLabel);
      return request<{ count: number }>(`/commits/count?${params}`);
    },
    sync: (projectId: string, repoIndex?: number) =>
      request<{ newCommits?: number; totalNewCommits?: number }>('/commits/sync', {
        method: 'POST',
        body: JSON.stringify({ projectId, repoIndex }),
      }),
    validateToken: (data: { provider: string; baseUrl?: string; owner?: string; repo?: string; gitlabProjectId?: string; token: string }) =>
      request<{ valid: boolean }>('/commits/validate-token', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    branches: (projectId: string, repoIndex: number) =>
      request<{ name: string; isDefault: boolean }[]>(`/commits/branches?projectId=${projectId}&repoIndex=${repoIndex}`),
  },
  workspaces: {
    list: (projectId: string, status?: WorkspaceStatus) => {
      const params = new URLSearchParams({ projectId });
      if (status) params.set('status', status);
      return request<Workspace[]>(`/workspaces?${params}`);
    },
    get: (id: string) => request<Workspace>(`/workspaces/${id}`),
    create: (data: { projectId: string; name: string; description?: string; repoUrl?: string; branch?: string; gitRepoId?: string }) =>
      request<Workspace>('/workspaces', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Pick<Workspace, 'name' | 'description' | 'repoUrl' | 'branch' | 'gitRepoId'>>) =>
      request<Workspace>(`/workspaces/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    archive: (id: string) =>
      request<Workspace>(`/workspaces/${id}/archive`, { method: 'POST' }),
    delete: (id: string) =>
      request<void>(`/workspaces/${id}`, { method: 'DELETE' }),
    /**
     * Streams shell command output via SSE for the manual terminal UI.
     * Each `data:` frame is parsed and forwarded to onEvent. abortSignal
     * aborts the upstream and triggers SIGKILL on the sidecar process.
     */
    execStream: async (
      id: string,
      command: string,
      onEvent: (event: WorkspaceStreamEvent) => void,
      signal: AbortSignal,
      opts?: { timeout?: number; env?: Record<string, string> },
    ): Promise<void> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = getAccessToken?.();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${BASE_URL}/workspaces/${id}/exec/stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command, timeout: opts?.timeout, env: opts?.env }),
        signal,
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(err.message || res.statusText);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const chunks = buf.split('\n\n');
          buf = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const line = chunk.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              onEvent(JSON.parse(data) as WorkspaceStreamEvent);
            } catch {
              // skip malformed
            }
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* noop */ }
      }
    },
  },
  snippets: {
    list: (projectId: string, filters?: { language?: string; category?: string; tag?: string }) => {
      const params = new URLSearchParams({ projectId });
      if (filters?.language) params.set('language', filters.language);
      if (filters?.category) params.set('category', filters.category);
      if (filters?.tag) params.set('tag', filters.tag);
      return request<Snippet[]>(`/snippets?${params}`);
    },
    listForCustomer: (customerId: string, filters?: { language?: string; category?: string; tag?: string }) => {
      const params = new URLSearchParams({ customerId });
      if (filters?.language) params.set('language', filters.language);
      if (filters?.category) params.set('category', filters.category);
      if (filters?.tag) params.set('tag', filters.tag);
      return request<Snippet[]>(`/snippets?${params}`);
    },
    search: (query: string, projectId?: string, customerId?: string) => {
      const params = new URLSearchParams({ q: query });
      if (projectId) params.set('projectId', projectId);
      if (customerId) params.set('customerId', customerId);
      return request<Snippet[]>(`/snippets/search?${params}`);
    },
    get: (id: string) => request<Snippet>(`/snippets/${id}`),
    create: (data: Partial<Snippet>) =>
      request<Snippet>('/snippets', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Snippet>) =>
      request<Snippet>(`/snippets/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/snippets/${id}`, { method: 'DELETE' }),
  },
  souls: {
    get: (projectId: string) => request<Soul | null>(`/souls?projectId=${projectId}`),
    getForCustomer: (customerId: string) => request<Soul | null>(`/souls?customerId=${customerId}`),
    upsert: (data: Partial<Soul> & { projectId?: string; customerId?: string }) =>
      request<Soul>('/souls', { method: 'PUT', body: JSON.stringify(data) }),
  },
  customerTemplates: {
    list: (filters?: { type?: string; active?: boolean; tag?: string }) => {
      const params = new URLSearchParams();
      if (filters?.type) params.set('type', filters.type);
      if (filters?.active !== undefined) params.set('active', String(filters.active));
      if (filters?.tag) params.set('tag', filters.tag);
      const qs = params.toString();
      return request<CustomerTemplate[]>(`/customer-templates${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<CustomerTemplate>(`/customer-templates/${id}`),
    create: (data: Partial<CustomerTemplate>) =>
      request<CustomerTemplate>('/customer-templates', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<CustomerTemplate>) =>
      request<CustomerTemplate>(`/customer-templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id: string) =>
      request<void>(`/customer-templates/${id}`, { method: 'DELETE' }),
    preview: (id: string, customerId: string) =>
      request<CustomerTemplatePreview>(`/customer-templates/${id}/preview`, {
        method: 'POST',
        body: JSON.stringify({ customerId }),
      }),
    apply: (id: string, customerId: string) =>
      request<CustomerTemplateApplyResult>(`/customer-templates/${id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ customerId }),
      }),
  },
  recurringTasks: {
    list: (filters?: { projectId?: string; customerId?: string; systemOnly?: boolean; active?: boolean }) => {
      const params = new URLSearchParams();
      if (filters?.projectId) params.set('projectId', filters.projectId);
      if (filters?.customerId) params.set('customerId', filters.customerId);
      if (filters?.systemOnly) params.set('systemOnly', 'true');
      if (filters?.active !== undefined) params.set('active', String(filters.active));
      const qs = params.toString();
      return request<RecurringTask[]>(`/recurring-tasks${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<RecurringTask>(`/recurring-tasks/${id}`),
    create: (data: Partial<RecurringTask>) =>
      request<RecurringTask>('/recurring-tasks', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<RecurringTask>) =>
      request<RecurringTask>(`/recurring-tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/recurring-tasks/${id}`, { method: 'DELETE' }),
    trigger: (id: string) =>
      request<RecurringTask>(`/recurring-tasks/${id}/trigger`, { method: 'POST' }),
  },
  transfer: {
    export: async (id: string, includeSecrets = false) => {
      const params = includeSecrets ? '?includeSecretValues=true' : '';
      const headers: Record<string, string> = {};
      const token = getAccessToken?.();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${BASE_URL}/project-transfer/${id}/export${params}`, { headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(err.message || res.statusText);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="(.+)"/);
      const filename = match?.[1] || 'project-export.json';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
    import: async (file: File, name?: string) => {
      const headers: Record<string, string> = {};
      const token = getAccessToken?.();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const formData = new FormData();
      formData.append('file', file);
      const params = name ? `?name=${encodeURIComponent(name)}` : '';
      const res = await fetch(`${BASE_URL}/project-transfer/import${params}`, {
        method: 'POST',
        headers,
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(err.message || res.statusText);
      }
      return res.json() as Promise<{ projectId: string; projectName: string; stats: Record<string, number> }>;
    },
  },
  auditLog: {
    list: (filters?: {
      action?: string;
      actorUserId?: string;
      entityType?: string;
      entityId?: string;
      since?: string;
      until?: string;
      limit?: number;
      offset?: number;
    }) => {
      const params = new URLSearchParams();
      if (filters?.action) params.set('action', filters.action);
      if (filters?.actorUserId) params.set('actorUserId', filters.actorUserId);
      if (filters?.entityType) params.set('entityType', filters.entityType);
      if (filters?.entityId) params.set('entityId', filters.entityId);
      if (filters?.since) params.set('since', filters.since);
      if (filters?.until) params.set('until', filters.until);
      if (filters?.limit) params.set('limit', String(filters.limit));
      if (filters?.offset) params.set('offset', String(filters.offset));
      const qs = params.toString();
      return request<{
        items: Array<{
          _id: string;
          action: string;
          actorUserId?: string;
          actorUsername?: string;
          actorRole?: string;
          actorApiKeyId?: string;
          entityType?: string;
          entityId?: string;
          meta?: Record<string, unknown>;
          ipAddress?: string;
          userAgent?: string;
          timestamp: string;
        }>;
        total: number;
      }>(`/audit-log${qs ? `?${qs}` : ''}`);
    },
    actions: () => request<string[]>('/audit-log/actions'),
  },
  customerTransfer: {
    export: async (customerId: string, includeSecrets = false) => {
      const params = includeSecrets ? '?includeSecretValues=true' : '';
      const headers: Record<string, string> = {};
      const token = getAccessToken?.();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${BASE_URL}/customer-transfer/${customerId}/export${params}`, { headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(err.message || res.statusText);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="(.+)"/);
      const filename = match?.[1] || 'customer-export.json';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
    import: async (file: File, name?: string) => {
      const headers: Record<string, string> = {};
      const token = getAccessToken?.();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const formData = new FormData();
      formData.append('file', file);
      const params = name ? `?name=${encodeURIComponent(name)}` : '';
      const res = await fetch(`${BASE_URL}/customer-transfer/import${params}`, {
        method: 'POST',
        headers,
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(err.message || res.statusText);
      }
      return res.json() as Promise<{
        customerId: string;
        imported: Record<string, number>;
        warnings: string[];
      }>;
    },
  },
  attachments: {
    storageStatus: () =>
      request<{ enabled: boolean; bucket?: string }>('/attachments/storage-status'),
    list: (projectId: string, entityType?: string, entityId?: string) => {
      const params = new URLSearchParams({ projectId });
      if (entityType) params.set('entityType', entityType);
      if (entityId) params.set('entityId', entityId);
      return request<Attachment[]>(`/attachments?${params}`);
    },
    listForCustomer: (customerId: string, entityType?: string, entityId?: string) => {
      const params = new URLSearchParams({ customerId });
      if (entityType) params.set('entityType', entityType);
      if (entityId) params.set('entityId', entityId);
      return request<Attachment[]>(`/attachments?${params}`);
    },
    get: (id: string) => request<Attachment>(`/attachments/${id}`),
    upload: async (
      owner: { projectId?: string; customerId?: string },
      file: File,
      opts?: { entityType?: string; entityId?: string; description?: string; tags?: string },
    ) => {
      const headers: Record<string, string> = {};
      const token = getAccessToken?.();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const formData = new FormData();
      formData.append('file', file);
      if (owner.projectId) formData.append('projectId', owner.projectId);
      if (owner.customerId) formData.append('customerId', owner.customerId);
      if (opts?.entityType) formData.append('entityType', opts.entityType);
      if (opts?.entityId) formData.append('entityId', opts.entityId);
      if (opts?.description) formData.append('description', opts.description);
      if (opts?.tags) formData.append('tags', opts.tags);
      const res = await fetch(`${BASE_URL}/attachments`, {
        method: 'POST',
        headers,
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(err.message || res.statusText);
      }
      return res.json() as Promise<Attachment>;
    },
    update: (id: string, data: { description?: string; tags?: string[]; entityType?: string; entityId?: string }) =>
      request<Attachment>(`/attachments/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/attachments/${id}`, { method: 'DELETE' }),
    downloadUrl: (id: string) => {
      const token = getAccessToken?.();
      const qs = token ? `?token=${encodeURIComponent(token)}` : '';
      return `${BASE_URL}/attachments/${id}/download${qs}`;
    },
    previewUrl: (id: string) => {
      const token = getAccessToken?.();
      const qs = token ? `?token=${encodeURIComponent(token)}` : '';
      return `${BASE_URL}/attachments/${id}/preview${qs}`;
    },
  },
  logs: {
    list: (projectId: string, filters?: { level?: string; service?: string; search?: string; startDate?: string; endDate?: string; limit?: number; offset?: number }) => {
      const params = new URLSearchParams({ projectId });
      if (filters?.level) params.set('level', filters.level);
      if (filters?.service) params.set('service', filters.service);
      if (filters?.search) params.set('search', filters.search);
      if (filters?.startDate) params.set('startDate', filters.startDate);
      if (filters?.endDate) params.set('endDate', filters.endDate);
      if (filters?.limit) params.set('limit', String(filters.limit));
      if (filters?.offset) params.set('offset', String(filters.offset));
      return request<LogEntry[]>(`/logs?${params}`);
    },
    stats: (projectId: string) =>
      request<LogStats>(`/logs/stats?projectId=${projectId}`),
  },
  releases: {
    list: (projectId: string, filters?: { status?: ReleaseStatus; platform?: ReleasePlatform; releaseType?: ReleaseType }) => {
      const params = new URLSearchParams({ projectId });
      if (filters?.status) params.set('status', filters.status);
      if (filters?.platform) params.set('platform', filters.platform);
      if (filters?.releaseType) params.set('releaseType', filters.releaseType);
      return request<Release[]>(`/releases?${params}`);
    },
    get: (id: string) => request<Release>(`/releases/${id}`),
    create: (data: Partial<Release>) =>
      request<Release>('/releases', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Release>) =>
      request<Release>(`/releases/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/releases/${id}`, { method: 'DELETE' }),
  },
  replication: {
    getConfig: () => request<ReplicationConfig>('/replication/config'),
    updateConfig: (data: Partial<ReplicationConfig>) =>
      request<ReplicationConfig>('/replication/config', { method: 'PUT', body: JSON.stringify(data) }),
    getStatus: () => request<ReplicationStatus>('/replication/status'),
    listProjects: () => request<ReplicationProjectEntry[]>('/replication/projects'),
    setProjectReplication: (id: string, enabled: boolean) =>
      request<{ _id: string; name: string; replicationEnabled: boolean }>(
        `/replication/projects/${id}`,
        { method: 'PATCH', body: JSON.stringify({ enabled }) },
      ),
    testConnection: () =>
      request<{ success: boolean; latency: number; error?: string }>('/replication/test-connection', { method: 'POST' }),
    triggerFullSync: (projectId?: string) => {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      return request<{ started: boolean; reason?: string; projectId?: string | null }>(
        `/replication/trigger-full-sync${qs}`,
        { method: 'POST' },
      );
    },
    triggerPull: () =>
      request<{ pulled: number; applied: number; skipped: number; rounds: number; error?: string }>(
        '/replication/trigger-pull',
        { method: 'POST' },
      ),
    promote: () =>
      request<{ role: string; message: string }>('/replication/promote', { method: 'POST' }),
    clearFailed: () =>
      request<{ cleared: number }>('/replication/queue/clear-failed', { method: 'POST' }),
    listRemoteProjects: () =>
      request<RemoteProjectEntry[]>('/replication/remote-projects'),
    importProjectFromPeer: (id: string) =>
      request<{ triggered: boolean; projectId: string; message: string }>(
        `/replication/import-project/${id}`,
        { method: 'POST' },
      ),
  },
  profile: {
    get: () => request<UserInfo>('/auth/profile'),
    update: (data: { username?: string; email?: string; llmConfig?: UserLlmConfig }) =>
      request<UserInfo>('/auth/profile', { method: 'PATCH', body: JSON.stringify(data) }),
    changePassword: (oldPassword: string, newPassword: string) =>
      request<{ message: string }>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword, newPassword }),
      }),
  },
  rag: {
    getConfig: () => request<RagConfig>('/rag/config'),
    updateConfig: (data: Pick<RagConfig, 'endpoints'>) =>
      request<RagConfig>('/rag/config', { method: 'PUT', body: JSON.stringify(data) }),
    testEndpoint: (endpoint: RagEndpoint) =>
      request<RagEndpointTestResult>('/rag/config/test', {
        method: 'POST',
        body: JSON.stringify(endpoint),
      }),
    reindex: (projectId?: string) => {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
      return request<{ indexed: number }>(`/rag/reindex${qs}`, { method: 'POST' });
    },
  },
  chat: {
    getConfig: () => request<ChatConfig>('/chat/config'),
    updateConfig: (data: Partial<ChatConfig>) =>
      request<ChatConfig>('/chat/config', { method: 'PUT', body: JSON.stringify(data) }),
    testEndpoint: (endpoint: ChatEndpoint) =>
      request<{ ok: boolean; error?: string; models?: string[] }>('/chat/config/test', {
        method: 'POST',
        body: JSON.stringify(endpoint),
      }),
    listSessions: (owner: { projectId?: string; customerId?: string }, includeArchived = false) => {
      const params = new URLSearchParams();
      if (owner.projectId) params.set('projectId', owner.projectId);
      if (owner.customerId) params.set('customerId', owner.customerId);
      if (includeArchived) params.set('includeArchived', 'true');
      return request<ChatSession[]>(`/chat/sessions?${params}`);
    },
    getSession: (id: string) => request<ChatSession>(`/chat/sessions/${id}`),
    createSession: (owner: { projectId?: string; customerId?: string }, title?: string) =>
      request<ChatSession>('/chat/sessions', {
        method: 'POST',
        body: JSON.stringify({ ...owner, title }),
      }),
    updateSession: (id: string, title: string) =>
      request<ChatSession>(`/chat/sessions/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ title }),
      }),
    deleteSession: (id: string) =>
      request<void>(`/chat/sessions/${id}`, { method: 'DELETE' }),
    prepareMessage: (sessionId: string, content: string, attachmentIds?: string[], workspaceId?: string | null) =>
      request<ChatPreparedPrompt>(`/chat/sessions/${sessionId}/prepare`, {
        method: 'POST',
        body: JSON.stringify({ content, attachmentIds, workspaceId: workspaceId ?? undefined }),
      }),
    uploadAttachment: async (sessionId: string, file: File): Promise<ChatAttachmentUploadResult> => {
      const headers: Record<string, string> = {};
      const token = getAccessToken?.();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${BASE_URL}/chat/sessions/${sessionId}/attachments`, {
        method: 'POST',
        headers,
        body: form,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(err.message || res.statusText);
      }
      return res.json();
    },
    persistMessage: (sessionId: string, data: ChatPersistInput) =>
      request<ChatSession>(`/chat/sessions/${sessionId}/persist`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    executeTool: (sessionId: string, payload: ChatExecuteToolInput) =>
      request<ChatToolExecutionResult>(`/chat/sessions/${sessionId}/tools/execute`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    streamMessage: async (
      sessionId: string,
      content: string,
      attachmentIds: string[] | undefined,
      handlers: {
        onContext?: (refs: ChatContextRef[]) => void;
        onToken?: (token: string) => void;
        onToolCall?: (call: { id: string; name: string; arguments: string }) => void;
        onToolResult?: (result: { id: string; success: boolean; summary: string }) => void;
        onStatus?: (status: { phase: string; name?: string; state?: string }) => void;
        onMetrics?: (metrics: ChatResponseMetrics) => void;
        onDone?: (reason?: string) => void;
        onError?: (message: string) => void;
      },
      signal?: AbortSignal,
      workspaceId?: string | null,
    ): Promise<void> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = getAccessToken?.();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${BASE_URL}/chat/sessions/${sessionId}/message`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ content, attachmentIds, workspaceId: workspaceId ?? undefined }),
        signal,
      });
      if (!res.ok || !res.body) {
        const error = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(error.message || res.statusText);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const line = chunk.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              const event = JSON.parse(data) as
                | { type: 'context'; refs: ChatContextRef[] }
                | { type: 'token'; content: string }
                | { type: 'tool_call'; id: string; name: string; arguments: string }
                | { type: 'tool_result'; id: string; success: boolean; summary: string }
                | { type: 'status'; phase: string; name?: string; state?: string }
                | { type: 'tool_status'; phase?: string; name?: string; state?: string }
                | ({ type: 'metrics' } & ChatResponseMetrics)
                | { type: 'done'; reason?: string }
                | { type: 'error'; message: string };
              if (event.type === 'context') handlers.onContext?.(event.refs);
              else if (event.type === 'token') handlers.onToken?.(event.content);
              else if (event.type === 'tool_call') handlers.onToolCall?.({ id: event.id, name: event.name, arguments: event.arguments });
              else if (event.type === 'tool_result') handlers.onToolResult?.({ id: event.id, success: event.success, summary: event.summary });
              else if (event.type === 'status') handlers.onStatus?.({ phase: event.phase, name: event.name, state: event.state });
              else if (event.type === 'tool_status') handlers.onStatus?.({ phase: event.phase ?? 'tool_call', name: event.name, state: event.state });
              else if (event.type === 'metrics') {
                const { type: _t, ...metrics } = event;
                handlers.onMetrics?.(metrics as ChatResponseMetrics);
              }
              else if (event.type === 'done') handlers.onDone?.(event.reason);
              else if (event.type === 'error') handlers.onError?.(event.message);
            } catch {
              /* ignore malformed event */
            }
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* noop */
        }
      }
    },
  },
  chatActivity: {
    list: (params: {
      projectId?: string;
      sessionId?: string;
      outcome?: ChatActivityOutcome;
      provider?: string;
      search?: string;
      startDate?: string;
      endDate?: string;
      limit?: number;
      offset?: number;
    } = {}) => {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
      });
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return request<ChatActivityList>(`/chat-activity${suffix}`);
    },
    stats: (params: { projectId?: string; days?: number } = {}) => {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) qs.append(k, String(v));
      });
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return request<ChatActivityStats>(`/chat-activity/stats${suffix}`);
    },
  },
  validationReports: {
    list: (filters: { projectId?: string; todoId?: string; status?: ValidationReportStatus; limit?: number } = {}) => {
      const params = new URLSearchParams();
      if (filters.projectId) params.set('projectId', filters.projectId);
      if (filters.todoId) params.set('todoId', filters.todoId);
      if (filters.status) params.set('status', filters.status);
      if (filters.limit) params.set('limit', String(filters.limit));
      const qs = params.toString();
      return request<ValidationReport[]>(`/validation-reports${qs ? `?${qs}` : ''}`);
    },
    latestForTodo: (todoId: string) =>
      request<ValidationReport | null>(`/validation-reports/todo/${todoId}/latest`),
    get: (id: string) => request<ValidationReport>(`/validation-reports/${id}`),
    proposeBugTodo: (
      id: string,
      body: { title?: string; priority?: 'low' | 'medium' | 'high' | 'critical'; milestoneId?: string; tags?: string[] } = {},
    ) =>
      request<{ report: ValidationReport; todo: Todo; reused: boolean }>(
        `/validation-reports/${id}/propose-bug-todo`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
  },
  docUpdateProposals: {
    list: (filters: {
      projectId?: string;
      status?: DocProposalStatus;
      sourceType?: DocProposalSourceType;
      sourceId?: string;
      targetType?: DocProposalTargetType;
      targetId?: string;
      limit?: number;
    } = {}) => {
      const params = new URLSearchParams();
      if (filters.projectId) params.set('projectId', filters.projectId);
      if (filters.status) params.set('status', filters.status);
      if (filters.sourceType) params.set('sourceType', filters.sourceType);
      if (filters.sourceId) params.set('sourceId', filters.sourceId);
      if (filters.targetType) params.set('targetType', filters.targetType);
      if (filters.targetId) params.set('targetId', filters.targetId);
      if (filters.limit) params.set('limit', String(filters.limit));
      const qs = params.toString();
      return request<DocUpdateProposal[]>(`/doc-update-proposals${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<DocUpdateProposal>(`/doc-update-proposals/${id}`),
    updateStatus: (id: string, body: { status: DocProposalStatus; note?: string }) =>
      request<DocUpdateProposal>(`/doc-update-proposals/${id}/status`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    convertToTodo: (
      id: string,
      body: { title?: string; priority?: 'low' | 'medium' | 'high' | 'critical'; milestoneId?: string; tags?: string[] } = {},
    ) =>
      request<{ proposal: DocUpdateProposal; todo: Todo; reused: boolean }>(
        `/doc-update-proposals/${id}/convert-to-todo`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    detectForTodo: (todoId: string) =>
      request<DocUpdateProposal[]>(`/doc-update-proposals/detect/todo/${todoId}`, { method: 'POST' }),
  },
  knowledgeGraph: {
    listEdges: (filters: {
      projectId?: string;
      entityType?: KgEntityType;
      entityId?: string;
      relation?: KgRelation;
      limit?: number;
    } = {}) => {
      const params = new URLSearchParams();
      if (filters.projectId) params.set('projectId', filters.projectId);
      if (filters.entityType) params.set('entityType', filters.entityType);
      if (filters.entityId) params.set('entityId', filters.entityId);
      if (filters.relation) params.set('relation', filters.relation);
      if (filters.limit) params.set('limit', String(filters.limit));
      const qs = params.toString();
      return request<KnowledgeGraphEdge[]>(`/knowledge-graph/edges${qs ? `?${qs}` : ''}`);
    },
    getEdge: (id: string) => request<KnowledgeGraphEdge>(`/knowledge-graph/edges/${id}`),
    createEdge: (body: Omit<KnowledgeGraphEdge, '_id' | 'createdAt' | 'updatedAt' | 'userConfirmed'> & { createdBy?: 'system' | 'agent' | 'user' }) =>
      request<KnowledgeGraphEdge>('/knowledge-graph/edges', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    deleteEdge: (id: string) =>
      request<{ deleted: boolean; id: string }>(`/knowledge-graph/edges/${id}`, { method: 'DELETE' }),
    confirmEdge: (id: string, confirmed = true) =>
      request<KnowledgeGraphEdge>(`/knowledge-graph/edges/${id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ confirmed }),
      }),
    neighbors: (projectId: string, entityType: KgEntityType, entityId: string) => {
      const qs = new URLSearchParams({ projectId, entityType, entityId }).toString();
      return request<KnowledgeGraphEdge[]>(`/knowledge-graph/neighbors?${qs}`);
    },
    impact: (projectId: string, entityType: KgEntityType, entityId: string, depth = 2) => {
      const qs = new URLSearchParams({ projectId, entityType, entityId, depth: String(depth) }).toString();
      return request<KnowledgeGraphImpact>(`/knowledge-graph/impact?${qs}`);
    },
    discover: (projectId: string) =>
      request<{ discovered: number; inserted: number; pruned: number }>(
        `/knowledge-graph/discover/${projectId}`,
        { method: 'POST' },
      ),
  },
  oracle: {
    analyze: (projectId: string) =>
      request<OracleAnalyzeResult>(`/oracle/analyze/${projectId}`, { method: 'POST' }),
    list: (filters: {
      projectId?: string;
      status?: OracleSuggestionStatus;
      severity?: OracleSeverity;
      type?: OracleRiskType;
      limit?: number;
    } = {}) => {
      const params = new URLSearchParams();
      if (filters.projectId) params.set('projectId', filters.projectId);
      if (filters.status) params.set('status', filters.status);
      if (filters.severity) params.set('severity', filters.severity);
      if (filters.type) params.set('type', filters.type);
      if (filters.limit) params.set('limit', String(filters.limit));
      const qs = params.toString();
      return request<OracleSuggestion[]>(`/oracle/suggestions${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<OracleSuggestion>(`/oracle/suggestions/${id}`),
    updateStatus: (id: string, body: { status: OracleSuggestionStatus; note?: string }) =>
      request<OracleSuggestion>(`/oracle/suggestions/${id}/status`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    convertToTodo: (
      id: string,
      body: { title?: string; priority?: 'low' | 'medium' | 'high' | 'critical'; milestoneId?: string; tags?: string[] } = {},
    ) =>
      request<{ suggestion: OracleSuggestion; todo: Todo; reused: boolean }>(
        `/oracle/suggestions/${id}/convert-to-todo`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    commentOnTodo: (id: string, body: { todoId?: string; note?: string } = {}) =>
      request<{ suggestion: OracleSuggestion; todoId: string; commented: true }>(
        `/oracle/suggestions/${id}/comment-on-todo`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    remove: (id: string) =>
      request<{ deleted: boolean; id: string }>(`/oracle/suggestions/${id}`, { method: 'DELETE' }),
  },
  workflowAgent: {
    getConfig: () => request<WorkflowAgentConfig | null>('/workflow-agent/config'),
    updateConfig: (data: WorkflowAgentConfigUpdate) =>
      request<WorkflowAgentConfig | null>('/workflow-agent/config', {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
  },
};

export type WorkflowAgentProvider = 'lmstudio' | 'openai-compatible' | 'openai' | 'anthropic';

export interface WorkflowAgentConfig {
  provider: WorkflowAgentProvider;
  url: string;
  model: string;
  hasApiKey: boolean;
  toolsEnabled: boolean;
  maxToolIterations: number;
}

export interface WorkflowAgentConfigUpdate {
  provider: WorkflowAgentProvider;
  url: string;
  model: string;
  apiKey?: string;
  toolsEnabled: boolean;
  maxToolIterations: number;
}

export type ChatProvider =
  | 'lmstudio'
  | 'openai-compatible'
  | 'anthropic'
  | 'openai';

export type RagProvider = 'ollama' | 'openai-compatible';

export interface RagEndpoint {
  provider: RagProvider;
  url: string;
  model: string;
  /** Plaintext key only when writing/testing. Server responses never include it. */
  apiKey?: string;
  hasApiKey?: boolean;
}

export interface RagConfig {
  endpoints: RagEndpoint[];
  managedViaSettings: boolean;
  status?: Record<string, unknown>;
}

export interface RagEndpointTestResult {
  ok: boolean;
  dimensions?: number;
  latencyMs?: number;
  error?: string;
}

export interface ChatEndpoint {
  provider: ChatProvider;
  url: string;
  model: string;
  /**
   * Klartext-Key nur beim schreiben. Leer/undefined beim Update = unverändert,
   * expliziter leerer String (über sentinel) = löschen. Nach dem Laden vom Server
   * ist dieses Feld NIE gesetzt — stattdessen `hasApiKey`.
   */
  apiKey?: string;
  /** Response-only: zeigt an ob ein Key beim Server liegt. */
  hasApiKey?: boolean;
  /** Wenn true: Endpoint akzeptiert Bild-Anhänge (vision model geladen). */
  visionCapable?: boolean;
}

export interface ChatConfig {
  enabled?: boolean;
  endpoints: ChatEndpoint[];
  temperature?: number;
  maxTokens?: number;
  topK?: number;
  historyLimit?: number;
  toolsEnabled?: boolean;
  toolsAllowlist?: string[];
  toolsMaxIterations?: number;
  availableTools?: string[];
  toolGroups?: Record<string, string[]>;
  /** Names of tools that mutate state — UI styles them with a warning. */
  writeTools?: string[];
}

export interface ChatContextRef {
  entity: string;
  entityId: string;
  title: string;
  score?: number;
}

export interface ChatToolCallRecord {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  success: boolean;
  error?: string;
}

export interface ChatAttachmentRef {
  attachmentId: string;
  fileName: string;
  size: number;
  extractedLength?: number;
  kind?: 'text' | 'image';
}

export interface ChatAttachmentUploadResult {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface ChatResponseMetrics {
  outputTokens: number;
  durationMs: number;
  firstTokenMs?: number;
  tokensPerSecond: number;
  totalDurationMs?: number;
  estimated: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: string;
  contextUsed?: ChatContextRef[];
  toolCalls?: ChatToolCallRecord[];
  attachments?: ChatAttachmentRef[];
  metrics?: ChatResponseMetrics;
}

export interface ChatSession {
  _id: string;
  projectId?: string;
  customerId?: string;
  title: string;
  messages: ChatMessage[];
  archived: boolean;
  model?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatPreparedTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}

export interface ChatPreparedPrompt {
  projectId: string;
  systemPrompt: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  contextRefs: ChatContextRef[];
  attachmentRefs?: ChatAttachmentRef[];
  attachmentStats?: {
    total: number;
    included: number;
    droppedByBudget: number;
    totalChars: number;
  };
  tools?: ChatPreparedTool[];
  toolsEnabled: boolean;
  toolsAllowlist: string[];
  toolsMaxIterations: number;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatPersistInput {
  userContent: string;
  assistantContent?: string;
  contextRefs?: ChatContextRef[];
  toolCalls?: ChatToolCallRecord[];
  attachmentIds?: string[];
  metrics?: ChatResponseMetrics;
  browserEndpointUrl?: string;
  browserModel?: string;
  browserAborted?: boolean;
}

export interface ChatActivityToolUse {
  name: string;
  count: number;
  errors: number;
}

export type ChatActivityOutcome = 'completed' | 'aborted' | 'failed' | 'no_endpoint';

export interface ChatActivityEntry {
  _id: string;
  sessionId?: string;
  userId?: string;
  projectId?: string;
  customerId?: string;
  mode: 'server' | 'browser';
  provider?: string;
  endpointUrl?: string;
  model?: string;
  toolsEnabled: boolean;
  toolsUsed?: ChatActivityToolUse[];
  outcome: ChatActivityOutcome;
  errorMessage?: string;
  outputTokens?: number;
  durationMs?: number;
  firstTokenMs?: number;
  tokensPerSecond?: number;
  estimated?: boolean;
  hadImages: boolean;
  userMessageLength?: number;
  createdAt: string;
}

export interface ChatActivityList {
  items: ChatActivityEntry[];
  total: number;
}

export interface ChatActivityStats {
  total: number;
  completed: number;
  failed: number;
  aborted: number;
  noEndpoint: number;
  byProvider: Array<{ provider: string; count: number; failures: number }>;
  byTool: Array<{ name: string; count: number; errors: number }>;
  avgTokensPerSecond: number | null;
  avgFirstTokenMs: number | null;
}

export interface ChatExecuteToolInput {
  name: string;
  projectId?: string;
  arguments?: Record<string, unknown>;
}

export interface ChatToolExecutionResult {
  success: boolean;
  error?: string;
  result?: unknown;
  /** Truncated JSON string suitable for appending to LLM message history */
  content: string;
  /** Short human-readable summary for UI */
  summary: string;
}

export type QuestionDirection = 'agent_to_user' | 'user_to_agent';
export type QuestionStatus = 'pending' | 'answered' | 'expired';

export interface Question {
  _id: string;
  question: string;
  options: string[];
  context?: string;
  todoId?: string;
  projectId?: string;
  targetUserId?: string;
  createdByUserId?: string;
  direction: QuestionDirection;
  status: QuestionStatus;
  answer?: string;
  answeredByUserId?: string;
  answeredByAgent?: boolean;
  answeredAt?: string;
  agentRunId?: string;
  agentName?: string;
  timeoutMs: number;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionsByTodoSummary {
  todoId: string;
  pendingAgentToUser: number;
  expiredAgentToUser: number;
  pendingUserToAgent: number;
  total: number;
  lastUpdatedAt: string;
}
