import {
  mergeHeaders,
  parseEmptyResponse,
  parseJsonResponse,
  parseJsonText,
  readErrorMessage,
  readErrorMessageFromText,
} from './http-boundary';
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
    headers: mergeHeaders(headers, options?.headers),
  });

  // Auto-refresh on 401
  if (res.status === 401 && onUnauthorized) {
    const refreshed = await onUnauthorized();
    if (refreshed) {
      const newToken = getAccessToken?.();
      if (newToken) headers['Authorization'] = `Bearer ${newToken}`;
      res = await fetch(`${BASE_URL}${path}`, {
        ...options,
        headers: mergeHeaders(headers, options?.headers),
      });
    }
  }

  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  // 204 hat keinen Body. Der Aufrufer deklariert dort typischerweise `void`;
  // die Grenze liegt in http-boundary.ts, nicht hier.
  if (res.status === 204) return parseEmptyResponse<T>();
  return parseJsonResponse<T>(res);
}

/**
 * Fetches a Markdown export (Content-Type: text/markdown) and returns the raw
 * text plus the filename parsed from Content-Disposition. Mirrors request<T>'s
 * 401-refresh/retry behavior exactly (only retries when the refresh actually
 * succeeded). Does not auto-download — callers decide what to do with the text.
 */
export async function requestMarkdown(path: string): Promise<{ text: string; filename: string }> {
  const buildHeaders = (): Record<string, string> => {
    const h: Record<string, string> = { Accept: 'text/markdown' };
    const token = getAccessToken?.();
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  };

  let res = await fetch(`${BASE_URL}${path}`, { headers: buildHeaders() });

  // Auto-refresh on 401 (mirrors request<T>)
  if (res.status === 401 && onUnauthorized) {
    const refreshed = await onUnauthorized();
    if (refreshed) {
      res = await fetch(`${BASE_URL}${path}`, { headers: buildHeaders() });
    }
  }

  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }

  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="(.+)"/);
  const filename = match?.[1] || 'export.md';
  const text = await res.text();
  return { text, filename };
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
  tags?: string[];
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

export interface StackEntry {
  _id: string;
  title: string;
  content: string;
  order: number;
}

export interface Stack {
  _id: string;
  name: string;
  description?: string;
  entries: StackEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface StackListItem {
  _id: string;
  name: string;
  description?: string;
  entryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStackPayload {
  name: string;
  description?: string;
}

export interface UpdateStackPayload {
  name?: string;
  description?: string;
}

export interface CreateStackEntryPayload {
  title: string;
  content?: string;
}

export interface UpdateStackEntryPayload {
  title?: string;
  content?: string;
  order?: number;
}

export interface ProjectTag {
  name: string;
  usageCount: number;
}

export interface ProjectSemanticHit {
  _id: string;
  name: string;
  description?: string;
  techStack: string[];
  tags: string[];
  active: boolean;
  favorite: boolean;
  score: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRelatedHit {
  entity: string;
  id: string;
  title: string;
  projectId: string;
  score: number;
}

export interface ProjectSemanticSearchResult {
  projects: ProjectSemanticHit[];
  relatedHits: ProjectRelatedHit[];
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

export interface AcceptanceCriterion {
  text: string;
  done: boolean;
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
  userStories?: string;
  acceptanceCriteria?: AcceptanceCriterion[];
  outOfScope?: string;
  edgeCases?: string;
  openQuestions?: string[];
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

export interface ParsedAcceptanceCriterion { text: string; done: boolean; }
export interface ParsedTodo { title: string; description?: string; priority?: string; status?: string; tags?: string[]; userStories?: string; acceptanceCriteria?: ParsedAcceptanceCriterion[]; outOfScope?: string; edgeCases?: string; }
export interface ParsedMilestone { name: string; description?: string; todos: ParsedTodo[]; }
export interface ImportResult { milestone: Milestone; todos: Todo[]; warnings?: string[]; }
export interface AiSuggestion { todoId: string; displayNumber: string; title: string; currentStatus: string; suggestedStatus: string; confidence: number; reason: string; }
export interface AiCompleteResult { milestoneId: string; modelUsed?: string; suggestions: AiSuggestion[]; warnings?: string[]; }

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

// ---------------------------------------------------------------------------
// Research Agent: topics/runs/artifacts (Task 14 backend, Phase 7)
// ---------------------------------------------------------------------------

export type ResearchFrequency =
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly';

export interface ResearchScope {
  mode: 'all' | 'selected';
  projectIds: string[];
  customerIds: string[];
  includeGlobal: boolean;
}

export interface ResearchWebSearchConfig {
  enabled: boolean;
  provider?: string;
}

export interface ResearchSchedule {
  frequency: ResearchFrequency;
  hour: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  month?: number;
  active: boolean;
  nextRun?: string;
  lastRun?: string;
  lastRunStatus?: string;
}

export interface ResearchGuardrails {
  maxIterations: number;
  maxWebSearches: number;
  maxWebFetches: number;
  timeoutMs: number;
}

export interface ResearchTopic {
  _id: string;
  number: number;
  displayNumber: string;
  title: string;
  brief: string;
  scope: ResearchScope;
  webSearch: ResearchWebSearchConfig;
  schedule: ResearchSchedule;
  guardrails: ResearchGuardrails;
  ownerUserId: string;
  notifyOnComplete: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET /research-topics/:id` currently returns the exact same shape as a
 * list entry (no extra nested composition) — kept as a distinct alias (not
 * merged into `ResearchTopic`) so call sites can be typed by intent, and so
 * the detail endpoint can grow extra fields later without a call-site churn.
 */
export type ResearchTopicDetail = ResearchTopic;

// Payload shapes mirror `CreateResearchTopicDto`/`UpdateResearchTopicDto`
// (backend `research-topic.dto.ts`) — `ownerUserId` is deliberately absent:
// it is always the authenticated caller, set server-side.

export interface ResearchScopeInput {
  mode: 'all' | 'selected';
  projectIds?: string[];
  customerIds?: string[];
  includeGlobal?: boolean;
}

export interface ResearchWebSearchConfigInput {
  enabled: boolean;
  provider?: string;
}

export interface ResearchScheduleInput {
  frequency: ResearchFrequency;
  hour: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  month?: number;
  active?: boolean;
}

export interface ResearchGuardrailsInput {
  maxIterations?: number;
  maxWebSearches?: number;
  maxWebFetches?: number;
  timeoutMs?: number;
}

export interface CreateResearchTopicPayload {
  title: string;
  brief: string;
  scope?: ResearchScopeInput;
  webSearch?: ResearchWebSearchConfigInput;
  schedule: ResearchScheduleInput;
  guardrails?: ResearchGuardrailsInput;
  notifyOnComplete?: boolean;
}

export type UpdateResearchTopicPayload = Partial<CreateResearchTopicPayload>;

export type ResearchArtifactSensitivity =
  | 'public'
  | 'internal'
  | 'confidential'
  | 'personal'
  | 'secret';

export interface ResearchArtifact {
  _id: string;
  topicId: string;
  slug: string;
  title: string;
  content: string;
  summary?: string;
  tags: string[];
  sources: string[];
  version: number;
  sensitivity: ResearchArtifactSensitivity;
  projectId?: string;
  customerId?: string;
  isGlobal: boolean;
  lastRunId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET /research-topics/:id/artifacts` returns this narrower projection
 * (slug/title/summary/version only) — mirrors `ArtifactSummary`
 * (backend `research-artifact.service.ts`), not the full `ResearchArtifact`.
 */
export interface ResearchArtifactSummary {
  slug: string;
  title: string;
  summary?: string;
  version: number;
}

// Mirrors `WriteResearchArtifactDto` — `slug` comes from the URL, `runId` is
// stamped server-side only for agent-driven writes, so neither is here.
export interface WriteResearchArtifactPayload {
  title: string;
  content: string;
  summary?: string;
  tags?: string[];
  sources?: string[];
  changeNote?: string;
}

export interface ResearchArtifactVersion {
  _id: string;
  artifactId: string;
  version: number;
  content: string;
  changeNote?: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
}

export type ResearchRunStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type ResearchRunTrigger = 'scheduled' | 'manual';

/** One step of the background agent's tool-calling loop (audit/debug trail). */
export interface RunStep {
  type: 'tool_call' | 'tool_result' | 'note';
  tool?: string;
  argsSummary?: string;
  resultSummary?: string;
  ts: string;
}

export interface RunTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ResearchRun {
  _id: string;
  topicId: string;
  number: number;
  status: ResearchRunStatus;
  trigger: ResearchRunTrigger;
  startedAt?: string;
  finishedAt?: string;
  steps: RunStep[];
  artifactsCreated: string[];
  artifactsUpdated: string[];
  tokenUsage?: RunTokenUsage;
  summary?: string;
  error?: string;
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

// ---- SSH connections ------------------------------------------------------

export type SshAuthMethod = 'key' | 'password';

/** Client-derived status (Spec §5.3). Backend has no `status` field. */
export type SshConnectionStatus =
  | 'ok'
  | 'never_tested'
  | 'error'
  | 'fingerprint_pending'
  | 'key_missing'
  | 'warning';

export interface SshLastConnectError {
  at: string;
  message: string;
}

/** Shape returned by `toListItem` in the backend SshController. */
export interface SshConnectionListItem {
  id: string;
  label: string;
  slug: string;
  customerId?: string;
  projectId?: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  tags: string[];
  knownHostFingerprintSet: boolean;
  lastConnectedAt?: string;
  lastConnectError?: SshLastConnectError;
  notifyOnAuthFailure: boolean;
  /** Per-connection SFTP upload cap in bytes; unset = use the global default. */
  maxUploadBytes?: number;
  /**
   * Set when this row was surfaced into a project-scoped listing because
   * its owning customer is linked to that project (T-386). Project tabs
   * use this marker to hide edit/delete affordances — the connection is
   * managed at the customer's "Server" tab. Customer-scoped lists never
   * set this field.
   */
  inheritedFromCustomerId?: string;
}

/** Shape returned by `toDetail` — list-shape + secret refs + accepted fingerprint. */
export interface SshConnectionDetail extends SshConnectionListItem {
  description?: string;
  privateKeySecretId?: string;
  passphraseSecretId?: string;
  passwordSecretId?: string;
  knownHostFingerprint?: string;
}

export interface SshTestErrorPayload {
  code:
    | 'auth_failed'
    | 'host_unreachable'
    | 'host_key_mismatch'
    | 'credential_missing'
    | 'timeout'
    | 'unknown';
  message: string;
}

export interface SshTestResult {
  ok: boolean;
  fingerprint?: string;
  fingerprintAccepted?: boolean;
  fingerprintMismatch?: boolean;
  error?: SshTestErrorPayload;
}

/**
 * Inline-secrets sub-object as accepted by `CreateSshConnectionDto`.
 * Backend nests by auth-method (NOT flat) — keep this shape locked.
 */
export interface SshCreateInlineSecrets {
  key?: {
    privateKey: string;
    passphrase?: string;
  };
  password?: {
    password: string;
  };
}

export interface SshConnectionCreateInput {
  label: string;
  slug: string;
  customerId?: string;
  projectId?: string;
  host: string;
  port?: number;
  username: string;
  authMethod: SshAuthMethod;
  description?: string;
  tags?: string[];
  notifyOnAuthFailure?: boolean;
  // Variant A — fresh secrets.
  inlineSecrets?: SshCreateInlineSecrets;
  // Variant B — pick-existing.
  privateKeySecretId?: string;
  passphraseSecretId?: string;
  passwordSecretId?: string;
}

export interface SshConnectionUpdateInput {
  label?: string;
  slug?: string;
  host?: string;
  port?: number;
  username?: string;
  description?: string;
  tags?: string[];
  notifyOnAuthFailure?: boolean;
  authMethod?: SshAuthMethod;
  // Credential rotation (only sent when the user explicitly unlocked the
  // credentials section in the edit form). Backend `SshService.update()`
  // accepts either inline secrets *or* existing secret IDs, never both.
  inlineSecrets?: SshCreateInlineSecrets;
  privateKeySecretId?: string;
  passphraseSecretId?: string;
  passwordSecretId?: string;
  maxUploadBytes?: number;
}

/** Global SSH upload-limit config from `GET/PUT /api/ssh-config`. */
export interface SshUploadConfig {
  maxUploadBytes: number;
  hardMaxBytes: number;
  defaultBytes: number;
}

export type SshAuditAction =
  | 'connect'
  | 'exec'
  | 'upload'
  | 'download'
  | 'list_files'
  | 'terminal_open'
  | 'terminal_close';

export type SshAuditSourceContext = 'terminal' | 'mcp' | 'rest';

/** One entry as returned by `GET /api/ssh-connections/:id/audit`. */
export interface SshAuditEntry {
  _id: string;
  at: string;
  action: SshAuditAction;
  sourceContext: SshAuditSourceContext;
  userId?: string;
  agentRoleId?: string;
  command?: string;
  remotePath?: string;
  bytes?: number;
  exitCode?: number;
  durationMs?: number;
  errorMsg?: string;
}

export interface SshAuditResponse {
  items: SshAuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface SshAuditQueryParams {
  limit?: number;
  offset?: number;
  sourceContext?: SshAuditSourceContext;
}

// ---- Kube clusters (K1) ----------------------------------------------------

/** Projected shape returned by the API — never carries the raw kubeconfig. */
export interface KubeCluster {
  _id: string;
  label: string;
  slug: string;
  projectId?: string;
  customerId?: string;
  contextName: string;
  clusterServer: string;
  defaultNamespace?: string;
  transport: 'direct' | 'ssh-tunnel';
  sshConnectionId?: string;
  readOnly: boolean;
  allowMcpWrites: boolean;
  allowInsecureTls: boolean;
  prometheus: { enabled: boolean; namespace?: string; service?: string; port?: number; path: string };
  description?: string;
  tags: string[];
  lastConnectedAt?: string;
  lastConnectError?: { at: string; message: string };
}

/** One context out of `POST /kube-clusters/parse-kubeconfig`. */
export interface ParsedKubeContext {
  contextName: string;
  clusterName: string;
  server: string;
  userName: string;
  namespace?: string;
  warnings: Array<'insecure_tls' | 'no_ca'>;
  /** Non-empty means this context is unselectable — the backend can't act on it. */
  rejections: Array<'exec_plugin' | 'auth_provider' | 'no_contexts' | 'unparsable'>;
}

export interface KubeConnectionTestResult {
  ok: boolean;
  serverVersion?: string;
  canWrite: boolean;
  verbs: string[];
  error?: string;
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
  /** T-337: only set on admin-list endpoint (`listAll`) and project-access lookup. */
  ownerUsername?: string;
  /** T-337: only set on admin-list endpoint. */
  userId?: string;
}

export interface ProjectAccess {
  apiKeys: ApiKeyInfo[];
  users: Array<{
    _id: string;
    username: string;
    role: string;
    projectScopeMode?: ScopeMode;
    allowedProjectIds?: string[];
  }>;
}

// T-339: shared filter + item types for audit-log list and export endpoints.
export interface AuditLogFilters {
  action?: string;
  actionPrefix?: string;
  actorUserId?: string;
  actorType?: 'user' | 'apikey' | 'system';
  entityType?: string;
  entityId?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogItem {
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
}

function auditLogParams(filters?: AuditLogFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters?.action) params.set('action', filters.action);
  if (filters?.actionPrefix) params.set('actionPrefix', filters.actionPrefix);
  if (filters?.actorUserId) params.set('actorUserId', filters.actorUserId);
  if (filters?.actorType) params.set('actorType', filters.actorType);
  if (filters?.entityType) params.set('entityType', filters.entityType);
  if (filters?.entityId) params.set('entityId', filters.entityId);
  if (filters?.since) params.set('since', filters.since);
  if (filters?.until) params.set('until', filters.until);
  return params;
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


// --- Harness (M-51/H1) ------------------------------------------------------

export type HarnessScope = 'global' | 'customer' | 'project';
export type HarnessSectionKind = 'prose' | 'bootstrap' | 'block' | 'constraint';
export type HarnessMergeStrategy = 'replace' | 'append' | 'prepend';

export interface HarnessSection {
  key: string;
  /**
   * Bewusst `string` und nicht die Union: eine von einer neueren Instanz
   * replizierte Section kann ein `kind` tragen, das dieser Build nicht kennt.
   * Das Backend reicht solche Werte durch, das UI muss sie anzeigen können.
   */
  kind: string;
  title: string;
  body: string;
  mergeStrategy: HarnessMergeStrategy;
  order: number;
  enabled: boolean;
}

export interface Harness {
  _id: string;
  scope: HarnessScope;
  projectId?: string;
  customerId?: string;
  description?: string;
  enabled: boolean;
  sections: HarnessSection[];
  createdAt?: string;
  updatedAt?: string;
}

/** Welche Ebene an einer aufgelösten Section beteiligt war, in Merge-Reihenfolge. */
export interface ResolvedSectionOrigin {
  scope: HarnessScope;
  customerId?: string;
  mergeStrategy: HarnessMergeStrategy;
}

export interface ResolvedHarnessSection {
  key: string;
  kind: string;
  title: string;
  body: string;
  order: number;
  origin: ResolvedSectionOrigin[];
}

export interface ResolvedHarness {
  sections: ResolvedHarnessSection[];
  /** Sections, die eine tiefere Ebene per Tombstone abgeschaltet hat. */
  suppressed: { key: string; scope: HarnessScope }[];
  resolvedFrom: { scope: HarnessScope; projectId?: string; customerId?: string }[];
  markdown: string;
}

export interface HarnessSummary {
  id: string;
  scope: HarnessScope;
  projectId?: string;
  customerId?: string;
  description?: string;
  enabled: boolean;
  sectionCount: number;
  updatedAt?: string;
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
  provider: 'github' | 'gitlab' | 'gitea';
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
  allowPrivateHost?: boolean;
}

export interface CommitEntry {
  _id: string;
  projectId: string;
  provider: 'github' | 'gitlab' | 'gitea';
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
  /** Active engine: 'legacy' (fire-on-emit) | 'log' (change-stream log). */
  engine?: 'legacy' | 'log';
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

// ── Change-stream log engine (Plan 3b–5) ──
export type ReplDirectionState = 'healthy' | 'degraded' | 'error' | 'paused';

export interface ReplDirectionHealth {
  state: ReplDirectionState;
  consecutiveFailures: number;
  lastErrorClass: 'terminal' | 'retryable' | null;
  nextAttemptAt: string | null;
}

export interface ReplSyncStatus {
  driver: string;
  outboundCursor: number;
  inboundCursor: number;
  localMaxSeq: number;
  outboundLag: number;
  lastCycleAt: string | null;
  running: boolean;
  deadletterCount: number;
  outbound: ReplDirectionHealth;
  inbound: ReplDirectionHealth;
  outboundBatchLimit: number;
  lastHeartbeatAt: string | null;
}

export interface ReplSyncCycleResult {
  pushed: number;
  pulled: number;
  applied: number;
  skipped: number;
  outboundCursor: number;
  inboundCursor: number;
  skippedReason?: string;
}

export interface ReplDeadletter {
  _id: string;
  direction: 'inbound' | 'outbound';
  eventId: string;
  seq: number;
  collection: string;
  documentId: string;
  reason: string;
  attempts: number;
  status: string;
  firstFailedAt?: string;
  lastFailedAt?: string;
}

export interface ReplGcResult {
  deleted: number;
  retentionDays: number;
  cutoff: string;
  maxSeqInclusive: number;
  guarded: boolean;
  deadletterOrphansDeleted: number;
  deadletterResolvedDeleted: number;
  skippedReason?: string;
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

export type WerkbankMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export interface WkKeyValue { key: string; value: string; enabled?: boolean }
export interface WkHeader { name: string; value: string; enabled?: boolean }
export interface WkAuth { type: 'none' | 'basic' | 'bearer'; username?: string; password?: string; token?: string }
export interface WkBody { mode: 'none' | 'raw' | 'form-urlencoded' | 'multipart'; raw?: string; contentType?: string; formFields?: WkKeyValue[] }

export interface RequestCollection {
  _id: string; projectId: string; name: string; description?: string; order: number;
  createdAt: string; updatedAt: string;
}
export interface SavedRequest {
  _id: string; projectId: string; collectionId: string; name: string; description?: string; order: number;
  method: WerkbankMethod; url: string; queryParams: WkKeyValue[]; headers: WkHeader[];
  auth: WkAuth; body: WkBody; timeoutMs: number; followRedirects: boolean;
  createdAt: string; updatedAt: string;
}
export interface SendResult {
  historyId: string; ok: boolean; status?: number; statusText?: string; durationMs: number;
  responseHeaders: { name: string; value: string }[]; body: string; truncated: boolean;
  bodySize: number; contentType?: string; error?: string; unresolvedVariables: string[];
}
export interface WerkbankHistoryEntry {
  _id: string; requestId: string; sentAt: string; durationMs: number; ok: boolean;
  method: string; url: string; requestHeaders: { name: string; value: string }[]; requestBody?: string;
  environmentName?: string; status?: number; statusText?: string;
  responseHeaders: { name: string; value: string }[]; bodyText: string; truncated: boolean;
  bodySize: number; contentType?: string; error?: string;
}
export interface ParsedCurlRequest {
  method: WerkbankMethod; url: string; queryParams: WkKeyValue[]; headers: WkHeader[];
  auth: WkAuth; body: WkBody; followRedirects: boolean; warnings: string[];
}

export type WebSearchProviderType = 'searxng' | 'tavily' | 'brave' | 'serpapi';

export interface PublicWebSearchProvider {
  type: WebSearchProviderType;
  baseUrl?: string;
  hasApiKey: boolean;
}

export interface PublicWebSearchConfig {
  activeProvider: WebSearchProviderType;
  providers: PublicWebSearchProvider[];
}

export interface SetWebSearchProvider {
  type: WebSearchProviderType;
  baseUrl?: string;
  /** undefined = keep stored key, '' = delete key, non-empty = set key. */
  apiKey?: string;
}

export interface SetWebSearchConfig {
  activeProvider: WebSearchProviderType;
  providers: SetWebSearchProvider[];
}

/**
 * Ereignis-Handler eines Chat-Streams (SSE).
 *
 * Von `streamMessage` und `resumeTool` geteilt: ein fortgesetzter Turn sendet
 * dieselben Ereignisse wie ein begonnener (T-415).
 */
export interface ChatStreamHandlers {
  onContext?: (refs: ChatContextRef[]) => void;
  onToken?: (token: string) => void;
  onToolCall?: (call: { id: string; name: string; arguments: string }) => void;
  onToolResult?: (result: { id: string; success: boolean; summary: string }) => void;
  /**
   * Der Server hat vor einem schreibenden Tool angehalten. Der Stream endet
   * danach; Fortsetzung über `api.chat.resumeTool`.
   */
  onToolConfirm?: (call: { id: string; name: string; arguments: string }) => void;
  onStatus?: (status: { phase: string; name?: string; state?: string }) => void;
  onMetrics?: (metrics: ChatResponseMetrics) => void;
  onDone?: (reason?: string) => void;
  onError?: (message: string) => void;
}

/** POST mit Auth-Header, dessen Antwort ein SSE-Stream ist. */
async function postChatStream(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getAccessToken?.();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Liest einen Chat-SSE-Stream und verteilt die Ereignisse.
 *
 * Eine Schleife für beide Aufrufer: zwei Kopien liefen garantiert auseinander,
 * sobald ein Ereignistyp dazukommt — genau das ist mit `tool_confirm` gerade
 * passiert.
 */
async function consumeChatStream(res: Response, handlers: ChatStreamHandlers): Promise<void> {
  if (!res.ok || !res.body) {
    throw new Error(await readErrorMessage(res));
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
          // Ein defektes Frame darf verworfen werden — der `catch` unten fängt
          // den Parse-Fehler, der Stream läuft weiter.
          const event = parseJsonText<ChatStreamEvent>(data);
          if (event.type === 'context') handlers.onContext?.(event.refs);
          else if (event.type === 'token') handlers.onToken?.(event.content);
          else if (event.type === 'tool_call') handlers.onToolCall?.({ id: event.id, name: event.name, arguments: event.arguments });
          else if (event.type === 'tool_result') handlers.onToolResult?.({ id: event.id, success: event.success, summary: event.summary });
          else if (event.type === 'tool_confirm') handlers.onToolConfirm?.({ id: event.id, name: event.name, arguments: event.arguments });
          else if (event.type === 'status') handlers.onStatus?.({ phase: event.phase, name: event.name, state: event.state });
          else if (event.type === 'tool_status') handlers.onStatus?.({ phase: event.phase ?? 'tool_call', name: event.name, state: event.state });
          else if (event.type === 'metrics') {
            // Felder explizit übernehmen statt `type` per Rest-Destructuring
            // wegzuwerfen — dann bleibt keine ungenutzte Variable übrig.
            handlers.onMetrics?.({
              outputTokens: event.outputTokens,
              durationMs: event.durationMs,
              firstTokenMs: event.firstTokenMs,
              tokensPerSecond: event.tokensPerSecond,
              totalDurationMs: event.totalDurationMs,
              estimated: event.estimated,
            });
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
    listTags: () => request<ProjectTag[]>('/projects/tags'),
    listCustomerLinks: () =>
      request<Array<{ projectId: string; customerId: string; customerName: string; status: string; createdAt: string }>>(
        '/projects/customer-links',
      ),
    searchSemantic: (q: string, customerId?: string, limit = 20) => {
      const params = new URLSearchParams({ q, limit: String(limit) });
      if (customerId) params.set('customerId', customerId);
      return request<ProjectSemanticSearchResult>(`/projects/search?${params.toString()}`);
    },
    renameTag: (from: string, to: string) =>
      request<{ modified: number }>('/projects/tags/rename', {
        method: 'POST',
        body: JSON.stringify({ from, to }),
      }),
    mergeTags: (sources: string[], target: string) =>
      request<{ modified: number }>('/projects/tags/merge', {
        method: 'POST',
        body: JSON.stringify({ sources, target }),
      }),
    deleteTag: (name: string) =>
      request<{ modified: number }>(`/projects/tags/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),
    // T-337: admin-only reverse-lookup — who can access this project?
    access: (id: string) => request<ProjectAccess>(`/projects/${id}/access`),
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
  httpRequests: {
    listCollections: (projectId: string) =>
      request<RequestCollection[]>(`/projects/${projectId}/request-collections`),
    createCollection: (projectId: string, data: { name: string; description?: string }) =>
      request<RequestCollection>(`/projects/${projectId}/request-collections`, { method: 'POST', body: JSON.stringify(data) }),
    updateCollection: (id: string, data: Partial<Pick<RequestCollection, 'name' | 'description' | 'order'>>) =>
      request<RequestCollection>(`/request-collections/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteCollection: (id: string) =>
      request<void>(`/request-collections/${id}`, { method: 'DELETE' }),
    listRequests: (projectId: string) =>
      request<SavedRequest[]>(`/projects/${projectId}/requests`),
    createRequest: (collectionId: string, data: Partial<SavedRequest>) =>
      request<SavedRequest>(`/request-collections/${collectionId}/requests`, { method: 'POST', body: JSON.stringify(data) }),
    getRequest: (id: string) => request<SavedRequest>(`/requests/${id}`),
    updateRequest: (id: string, data: Partial<SavedRequest>) =>
      request<SavedRequest>(`/requests/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteRequest: (id: string) =>
      request<void>(`/requests/${id}`, { method: 'DELETE' }),
    send: (id: string, data: { environmentId?: string } & Partial<SavedRequest>) =>
      request<SendResult>(`/requests/${id}/send`, { method: 'POST', body: JSON.stringify(data) }),
    history: (id: string, limit = 50) =>
      request<WerkbankHistoryEntry[]>(`/requests/${id}/history?limit=${limit}`),
    parseCurl: (curl: string) =>
      request<ParsedCurlRequest>(`/http-requests/parse-curl`, { method: 'POST', body: JSON.stringify({ curl }) }),
    downloadTicket: (id: string, environmentId?: string) =>
      request<{ ticket: string; url: string }>(`/requests/${id}/download-ticket`, {
        method: 'POST',
        body: JSON.stringify({ environmentId }),
      }),
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
    askQuestion: (
      todoId: string,
      data: { question: string; options?: string[]; context?: string; timeoutSeconds?: number; agentName?: string },
    ) =>
      request<Question>(`/todos/${todoId}/questions`, {
        method: 'POST',
        body: JSON.stringify(data),
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
    list: (projectId: string, opts?: number | { limit?: number; entityType?: string; entityId?: string }) => {
      const params = new URLSearchParams({ projectId });
      const o = typeof opts === 'number' ? { limit: opts } : opts;
      if (o?.limit) params.set('limit', String(o.limit));
      if (o?.entityType) params.set('entityType', o.entityType);
      if (o?.entityId) params.set('entityId', o.entityId);
      return request<Activity[]>(`/activities?${params}`);
    },
    listForCustomer: (customerId: string, limit?: number) => {
      const params = new URLSearchParams({ customerId });
      if (limit) params.set('limit', String(limit));
      return request<Activity[]>(`/activities?${params}`);
    },
    // T-335: global feed across everything the user can see.
    listGlobal: (opts?: { limit?: number; entityType?: string; entityId?: string }) => {
      const params = new URLSearchParams();
      if (opts?.limit) params.set('limit', String(opts.limit));
      if (opts?.entityType) params.set('entityType', opts.entityType);
      if (opts?.entityId) params.set('entityId', opts.entityId);
      const qs = params.toString();
      return request<Activity[]>(qs ? `/activities?${qs}` : '/activities');
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
    exportRaw: async (id: string) => {
      const headers: Record<string, string> = {};
      const token = getAccessToken?.();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${BASE_URL}/milestones/${id}/export.md`, { headers });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res));
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="(.+)"/);
      const filename = match?.[1] || `milestone-${id}.md`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
    importPreview: (markdown: string) =>
      request<ParsedMilestone>('/milestones/import/preview', {
        method: 'POST',
        body: JSON.stringify({ markdown }),
      }),
    importApply: (projectId: string, parsed: ParsedMilestone) =>
      request<ImportResult>('/milestones/import/apply', {
        method: 'POST',
        body: JSON.stringify({ projectId, parsed }),
      }),
    aiComplete: (id: string, summaryMarkdown: string) =>
      request<AiCompleteResult>(`/milestones/${id}/ai-complete`, {
        method: 'POST',
        body: JSON.stringify({ summaryMarkdown }),
      }),
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
  // Flat, not namespaced under `kube:` — later K-phase tasks call these
  // exact names (`api.parseKubeconfig`, `api.listKubeClusters`, …).
  parseKubeconfig: (kubeconfig: string) =>
    request<{ contexts: ParsedKubeContext[]; currentContext?: string }>(
      '/kube-clusters/parse-kubeconfig',
      { method: 'POST', body: JSON.stringify({ kubeconfig }) },
    ),
  listKubeClusters: (scope: { projectId?: string; customerId?: string }) =>
    request<KubeCluster[]>(
      `/kube-clusters?${new URLSearchParams(
        scope.projectId ? { projectId: scope.projectId } : { customerId: scope.customerId ?? '' },
      ).toString()}`,
    ),
  createKubeCluster: (body: Record<string, unknown>) =>
    request<KubeCluster>('/kube-clusters', { method: 'POST', body: JSON.stringify(body) }),
  deleteKubeCluster: (id: string) =>
    request<void>(`/kube-clusters/${id}`, { method: 'DELETE' }),
  testKubeCluster: (id: string) =>
    request<KubeConnectionTestResult>(`/kube-clusters/${id}/test`, { method: 'POST' }),
  ssh: {
    listForCustomer: (customerId: string) =>
      request<SshConnectionListItem[]>(`/customers/${customerId}/ssh-connections`),
    listForProject: (projectId: string) =>
      request<SshConnectionListItem[]>(`/projects/${projectId}/ssh-connections`),
    get: (id: string) => request<SshConnectionDetail>(`/ssh-connections/${id}`),
    create: (data: SshConnectionCreateInput) =>
      request<SshConnectionDetail>('/ssh-connections', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: SshConnectionUpdateInput) =>
      request<SshConnectionDetail>(`/ssh-connections/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<void>(`/ssh-connections/${id}`, { method: 'DELETE' }),
    test: (id: string) =>
      request<SshTestResult>(`/ssh-connections/${id}/test`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    acceptFingerprint: (id: string, fingerprint: string) =>
      request<SshConnectionDetail>(`/ssh-connections/${id}/accept-fingerprint`, {
        method: 'POST',
        body: JSON.stringify({ fingerprint }),
      }),
    getAudit: (id: string, params: SshAuditQueryParams = {}) => {
      const qs = new URLSearchParams();
      if (params.limit !== undefined) qs.set('limit', String(params.limit));
      if (params.offset !== undefined) qs.set('offset', String(params.offset));
      if (params.sourceContext) qs.set('sourceContext', params.sourceContext);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return request<SshAuditResponse>(`/ssh-connections/${id}/audit${suffix}`);
    },
    getConfig: () => request<SshUploadConfig>('/ssh-config'),
    setConfig: (maxUploadBytes: number) =>
      request<SshUploadConfig>('/ssh-config', {
        method: 'PUT',
        body: JSON.stringify({ maxUploadBytes }),
      }),
    uploadFile: (
      id: string,
      file: File,
      remotePath: string,
      opts: { createDirs?: boolean; mode?: number } = {},
      onProgress?: (fraction: number) => void,
    ) =>
      new Promise<{ bytesWritten: number; remotePath: string }>((resolve, reject) => {
        const form = new FormData();
        // Fields must precede the file part so the server parses them before
        // the file stream opens.
        form.append('remotePath', remotePath);
        if (opts.createDirs) form.append('createDirs', 'true');
        if (opts.mode !== undefined) form.append('mode', String(opts.mode));
        form.append('file', file);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${BASE_URL}/ssh-connections/${id}/upload`);
        const token = getCurrentAccessToken();
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(parseJsonText<{ bytesWritten: number; remotePath: string }>(xhr.responseText));
            } catch {
              resolve({ bytesWritten: 0, remotePath });
            }
          } else {
            const msg = readErrorMessageFromText(xhr.responseText) ?? xhr.responseText;
            reject(new Error(msg || `upload failed (${xhr.status})`));
          }
        };
        xhr.onerror = () => reject(new Error('network error during upload'));
        xhr.send(form);
      }),
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
    convertToKnowledge: (
      questionId: string,
      data: { topic: string; content?: string; tags?: string[]; category?: string; scope?: string },
    ) =>
      request<Knowledge>(`/questions/${questionId}/convert-to-knowledge`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    listAll: (filters: {
      status?: QuestionStatus[];
      direction?: QuestionDirection;
      projectId?: string;
      customerId?: string;
      todoId?: string;
      milestoneId?: string;
      researchSessionId?: string;
      chatSessionId?: string;
      targetUserId?: string;
      createdByUserId?: string;
      agentName?: string;
      createdAfter?: string;
      createdBefore?: string;
      q?: string;
      limit?: number;
      offset?: number;
    } = {}) => {
      const qs = new URLSearchParams();
      if (filters.status && filters.status.length > 0) qs.set('status', filters.status.join(','));
      if (filters.direction) qs.set('direction', filters.direction);
      if (filters.projectId) qs.set('projectId', filters.projectId);
      if (filters.customerId) qs.set('customerId', filters.customerId);
      if (filters.todoId) qs.set('todoId', filters.todoId);
      if (filters.milestoneId) qs.set('milestoneId', filters.milestoneId);
      if (filters.researchSessionId) qs.set('researchSessionId', filters.researchSessionId);
      if (filters.chatSessionId) qs.set('chatSessionId', filters.chatSessionId);
      if (filters.targetUserId) qs.set('targetUserId', filters.targetUserId);
      if (filters.createdByUserId) qs.set('createdByUserId', filters.createdByUserId);
      if (filters.agentName) qs.set('agentName', filters.agentName);
      if (filters.createdAfter) qs.set('createdAfter', filters.createdAfter);
      if (filters.createdBefore) qs.set('createdBefore', filters.createdBefore);
      if (filters.q) qs.set('q', filters.q);
      if (filters.limit !== undefined) qs.set('limit', String(filters.limit));
      if (filters.offset !== undefined) qs.set('offset', String(filters.offset));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      return request<{ items: Question[]; total: number }>(`/questions${suffix}`);
    },
    cancel: (id: string, reason?: string) =>
      request<Question>(`/questions/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    snooze: (id: string, snoozeUntil: string) =>
      request<Question>(`/questions/${id}/snooze`, {
        method: 'POST',
        body: JSON.stringify({ snoozeUntil }),
      }),
    createFollowupTodo: (
      id: string,
      data: { title?: string; description?: string; priority?: 'low' | 'medium' | 'high' | 'critical' } = {},
    ) =>
      request<{ todoId: string; question: Question }>(`/questions/${id}/create-followup-todo`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    markAsDecision: (
      id: string,
      data: { decision: string; rationale?: string; scope?: string; tags?: string[] },
    ) =>
      request<{ knowledgeId: string; question: Question }>(`/questions/${id}/mark-as-decision`, {
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
    getConfig: () => request<PublicWebSearchConfig>('/web-search/config'),
    setConfig: (cfg: SetWebSearchConfig) =>
      request<PublicWebSearchConfig>('/web-search/config', {
        method: 'PUT',
        body: JSON.stringify(cfg),
      }),
    testConfig: (p: SetWebSearchProvider) =>
      request<{ ok: boolean; count: number; error?: string }>('/web-search/config/test', {
        method: 'POST',
        body: JSON.stringify(p),
      }),
  },
  // Research Agent (Task 14 backend): topic CRUD, run history, artifact CRUD.
  // The two SSE endpoints (`POST /research-topics/:id/runs` to start+stream a
  // manual run, `GET /research-runs/:id/stream` to attach to one) are
  // deliberately NOT wrapped here — they are consumed directly via
  // fetch/EventSource in the components that need them (same pattern as
  // `notepad/PromotionDialog.tsx`'s fetch+ReadableStream promotion stream),
  // since `request<T>` assumes a single JSON response body, not a stream.
  researchTopics: {
    list: (filters?: { active?: boolean; q?: string }) => {
      const params = new URLSearchParams();
      if (filters?.active !== undefined) params.set('active', String(filters.active));
      if (filters?.q) params.set('q', filters.q);
      const qs = params.toString();
      return request<ResearchTopic[]>(`/research-topics${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<ResearchTopicDetail>(`/research-topics/${id}`),
    create: (data: CreateResearchTopicPayload) =>
      request<ResearchTopic>('/research-topics', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: UpdateResearchTopicPayload) =>
      request<ResearchTopic>(`/research-topics/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) => request<void>(`/research-topics/${id}`, { method: 'DELETE' }),

    runsList: (id: string) => request<ResearchRun[]>(`/research-topics/${id}/runs`),

    artifactsList: (id: string) =>
      request<ResearchArtifactSummary[]>(`/research-topics/${id}/artifacts`),
    artifactGet: (id: string, slug: string) =>
      request<ResearchArtifact>(`/research-topics/${id}/artifacts/${slug}`),
    artifactSave: (id: string, slug: string, data: WriteResearchArtifactPayload) =>
      request<ResearchArtifact>(`/research-topics/${id}/artifacts/${slug}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    artifactDelete: (id: string, slug: string) =>
      request<void>(`/research-topics/${id}/artifacts/${slug}`, { method: 'DELETE' }),
    artifactVersions: (id: string, slug: string) =>
      request<ResearchArtifactVersion[]>(`/research-topics/${id}/artifacts/${slug}/versions`),
  },
  researchRuns: {
    get: (id: string) => request<ResearchRun>(`/research-runs/${id}`),
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
    // T-337: admin-only listing across all users, with ownerUsername.
    listAll: () => request<ApiKeyInfo[]>('/api-keys/all'),
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
        throw new Error(await readErrorMessage(res));
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
              onEvent(parseJsonText<WorkspaceStreamEvent>(data));
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
  harness: {
    /**
     * Die rohe Ebene. Das Backend liefert `{}` statt `null`, wenn es sie noch
     * nicht gibt (Nest serialisiert `null` als leeren Body, woran `res.json()`
     * scheitert) — daran erkennt der Aufrufer den Fall am fehlenden `_id`.
     */
    get: (owner: { scope: HarnessScope; projectId?: string; customerId?: string }) => {
      const params = new URLSearchParams({ scope: owner.scope });
      if (owner.projectId) params.set('projectId', owner.projectId);
      if (owner.customerId) params.set('customerId', owner.customerId);
      return request<Harness | Record<string, never>>(`/harness?${params.toString()}`);
    },
    resolve: (projectId: string) => request<ResolvedHarness>(`/harness/resolve/${projectId}`),
    list: (scope?: HarnessScope) =>
      request<HarnessSummary[]>(`/harness/list${scope ? `?scope=${scope}` : ''}`),
    sectionSet: (
      owner: { scope: HarnessScope; projectId?: string; customerId?: string },
      section: Partial<HarnessSection> & { key: string; kind: string },
    ) => {
      const params = new URLSearchParams({ scope: owner.scope });
      if (owner.projectId) params.set('projectId', owner.projectId);
      if (owner.customerId) params.set('customerId', owner.customerId);
      return request<Harness>(`/harness/sections/${encodeURIComponent(section.key)}?${params.toString()}`, {
        method: 'PUT',
        body: JSON.stringify(section),
      });
    },
    sectionDelete: (
      owner: { scope: HarnessScope; projectId?: string; customerId?: string },
      key: string,
    ) => {
      const params = new URLSearchParams({ scope: owner.scope });
      if (owner.projectId) params.set('projectId', owner.projectId);
      if (owner.customerId) params.set('customerId', owner.customerId);
      return request<Harness>(`/harness/sections/${encodeURIComponent(key)}?${params.toString()}`, {
        method: 'DELETE',
      });
    },
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
        throw new Error(await readErrorMessage(res));
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
        throw new Error(await readErrorMessage(res));
      }
      return parseJsonResponse<{ projectId: string; projectName: string; stats: Record<string, number> }>(res);
    },
  },
  auditLog: {
    list: (filters?: AuditLogFilters) => {
      const params = auditLogParams(filters);
      if (filters?.limit) params.set('limit', String(filters.limit));
      if (filters?.offset) params.set('offset', String(filters.offset));
      const qs = params.toString();
      return request<{
        items: AuditLogItem[];
        total: number;
      }>(`/audit-log${qs ? `?${qs}` : ''}`);
    },
    // T-339: server-side filtered JSON export, max 10k rows.
    exportAll: (filters?: AuditLogFilters) => {
      const params = auditLogParams(filters);
      const qs = params.toString();
      return request<{ items: AuditLogItem[]; truncated: boolean }>(
        `/audit-log/export${qs ? `?${qs}` : ''}`,
      );
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
        throw new Error(await readErrorMessage(res));
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
        throw new Error(await readErrorMessage(res));
      }
      return parseJsonResponse<{
        customerId: string;
        imported: Record<string, number>;
        warnings: string[];
      }>(res);
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
        throw new Error(await readErrorMessage(res));
      }
      return parseJsonResponse<Attachment>(res);
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
    // T-338: admin-only cross-project view.
    listGlobal: (filters?: { projectIds?: string[]; level?: string; service?: string; search?: string; startDate?: string; endDate?: string; limit?: number; offset?: number }) => {
      const params = new URLSearchParams();
      if (filters?.projectIds && filters.projectIds.length > 0) params.set('projectIds', filters.projectIds.join(','));
      if (filters?.level) params.set('level', filters.level);
      if (filters?.service) params.set('service', filters.service);
      if (filters?.search) params.set('search', filters.search);
      if (filters?.startDate) params.set('startDate', filters.startDate);
      if (filters?.endDate) params.set('endDate', filters.endDate);
      if (filters?.limit) params.set('limit', String(filters.limit));
      if (filters?.offset) params.set('offset', String(filters.offset));
      const qs = params.toString();
      return request<LogEntry[]>(qs ? `/logs/global?${qs}` : '/logs/global');
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
    // ── Change-stream log engine ──
    getSyncStatus: () => request<ReplSyncStatus>('/replication/sync/status'),
    syncNow: () => request<ReplSyncCycleResult>('/replication/sync/now', { method: 'POST' }),
    listDeadletters: () =>
      request<{ count: number; items: ReplDeadletter[] }>('/replication/deadletter'),
    replayDeadletter: (id: string) =>
      request<{ ok: boolean; reason?: string }>(`/replication/deadletter/${id}/replay`, { method: 'POST' }),
    discardDeadletter: (id: string) =>
      request<{ ok: boolean }>(`/replication/deadletter/${id}/discard`, { method: 'POST' }),
    runGc: () => request<ReplGcResult>('/replication/gc/run', { method: 'POST' }),
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
    prepareMessage: (sessionId: string, content: string, attachmentIds?: string[], workspaceId?: string | null, briefingMode?: boolean) =>
      request<ChatPreparedPrompt>(`/chat/sessions/${sessionId}/prepare`, {
        method: 'POST',
        body: JSON.stringify({ content, attachmentIds, workspaceId: workspaceId ?? undefined, briefingMode: briefingMode ?? undefined }),
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
        throw new Error(await readErrorMessage(res));
      }
      return parseJsonResponse(res);
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
      handlers: ChatStreamHandlers,
      signal?: AbortSignal,
      workspaceId?: string | null,
      briefingMode?: boolean,
    ): Promise<void> => {
      const res = await postChatStream(
        `/chat/sessions/${sessionId}/message`,
        {
          content,
          attachmentIds,
          workspaceId: workspaceId ?? undefined,
          briefingMode: briefingMode ?? undefined,
        },
        signal,
      );
      await consumeChatStream(res, handlers);
    },

    /**
     * Setzt einen Turn fort, der vor einem schreibenden Tool angehalten hat
     * (T-415).
     *
     * Antwort ist derselbe Ereignisstrom wie bei `streamMessage` — deshalb
     * teilen sich beide Handler und Leseschleife. `approved: false` führt das
     * Tool nicht aus, meldet es dem Modell aber als abgelehnt zurück.
     */
    resumeTool: async (
      sessionId: string,
      body: { callId: string; approved: boolean },
      handlers: ChatStreamHandlers,
      signal?: AbortSignal,
    ): Promise<void> => {
      const res = await postChatStream(`/chat/sessions/${sessionId}/tools/resume`, body, signal);
      await consumeChatStream(res, handlers);
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
  llmEndpoints: {
    list: () => request<LlmEndpoint[]>('/llm-endpoints'),
    create: (data: LlmEndpointInput) =>
      request<LlmEndpoint>('/llm-endpoints', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: LlmEndpointInput) =>
      request<LlmEndpoint>(`/llm-endpoints/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id: string) =>
      request<{ ok: true }>(`/llm-endpoints/${id}`, { method: 'DELETE' }),
    test: (id: string) =>
      request<{ ok: boolean; latencyMs?: number; error?: string; models?: string[] }>(`/llm-endpoints/${id}/test`, {
        method: 'POST',
      }),
    /** Probe an unsaved (add/edit form) endpoint + list its models. */
    probe: (data: { provider: string; baseUrl: string; apiKey?: string; id?: string }) =>
      request<{ ok: boolean; latencyMs?: number; error?: string; models?: string[] }>('/llm-endpoints/test', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
  balancer: {
    status: () => request<BalancerStatus>('/balancer/status'),
  },
  stacks: {
    list: () => request<StackListItem[]>('/stacks'),
    get: (id: string) => request<Stack>(`/stacks/${id}`),
    create: (data: CreateStackPayload) =>
      request<Stack>('/stacks', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: UpdateStackPayload) =>
      request<Stack>(`/stacks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) => request<void>(`/stacks/${id}`, { method: 'DELETE' }),
    addEntry: (id: string, data: CreateStackEntryPayload) =>
      request<Stack>(`/stacks/${id}/entries`, { method: 'POST', body: JSON.stringify(data) }),
    updateEntry: (id: string, entryId: string, data: UpdateStackEntryPayload) =>
      request<Stack>(`/stacks/${id}/entries/${entryId}`, { method: 'PATCH', body: JSON.stringify(data) }),
    removeEntry: (id: string, entryId: string) =>
      request<void>(`/stacks/${id}/entries/${entryId}`, { method: 'DELETE' }),
    reorder: (id: string, entryIds: string[]) =>
      request<Stack>(`/stacks/${id}/reorder`, { method: 'PATCH', body: JSON.stringify({ entryIds }) }),
    exportMarkdown: (id: string) => requestMarkdown(`/stacks/${id}/export.md`),
    exportEntryMarkdown: (id: string, entryId: string) =>
      requestMarkdown(`/stacks/${id}/entries/${entryId}/export.md`),
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

export type LlmEndpointProvider = 'openai-compatible' | 'anthropic' | 'openai' | 'ollama';

export type LlmEndpointPurpose = 'chat' | 'embedding' | 'workflow';

export interface LlmEndpoint {
  id: string;
  label: string;
  provider: LlmEndpointProvider;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  purposes: LlmEndpointPurpose[];
  visionCapable: boolean;
  concurrency: number;
  priority: number;
  timeoutMs: number;
  enabled: boolean;
}

export interface LlmEndpointInput {
  label: string;
  provider: LlmEndpointProvider;
  baseUrl: string;
  model: string;
  /** Klartext-Key nur beim Schreiben. undefined = unverändert, '' = löschen, Wert = setzen. */
  apiKey?: string;
  purposes: LlmEndpointPurpose[];
  visionCapable: boolean;
  concurrency: number;
  priority: number;
  timeoutMs: number;
  enabled: boolean;
}

export interface BalancerPoolStatus {
  purpose: string;
  capacity: number;
  waiting: number;
  active: number;
}

export interface BalancerEndpointStatus {
  id: string;
  label: string;
  purposes: string[];
  enabled: boolean;
  concurrency: number;
  inFlight: number;
  healthy: boolean;
}

export interface BalancerQueueStatus {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused?: number;
}

export interface BalancerEndpointUsage {
  endpointId: string;
  totalTokens: number;
  errors: number;
  count: number;
}

export interface BalancerUsage {
  perEndpoint: BalancerEndpointUsage[];
}

export interface BalancerStatus {
  pools: BalancerPoolStatus[];
  endpoints: BalancerEndpointStatus[];
  queue: BalancerQueueStatus;
  usage: BalancerUsage;
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

/**
 * Die SSE-Frames von `POST /chat/sessions/:id/message`. Nur ein Namensdach über
 * dem, was der Server sendet — `parseJsonText` behauptet diesen Typ, geprüft
 * wird er nicht. Ein Frame, der nicht passt, landet im `default`-Zweig des
 * Dispatchers und wird ignoriert.
 */
export type ChatStreamEvent =
  | { type: 'context'; refs: ChatContextRef[] }
  | { type: 'token'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; id: string; success: boolean; summary: string }
  /** Server hält vor einem schreibenden Tool an und beendet den Stream (T-415). */
  | { type: 'tool_confirm'; id: string; name: string; arguments: string }
  | { type: 'status'; phase: string; name?: string; state?: string }
  | { type: 'tool_status'; phase?: string; name?: string; state?: string }
  | ({ type: 'metrics' } & ChatResponseMetrics)
  | { type: 'done'; reason?: string }
  | { type: 'error'; message: string };

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
export type QuestionStatus =
  | 'pending'
  | 'answered'
  | 'expired'
  | 'snoozed'
  | 'cancelled'
  | 'superseded';

export type EscalationTargetKind = 'user' | 'role' | 'broadcast';

export interface EscalationStep {
  kind: EscalationTargetKind;
  userId?: string;
  role?: string;
  afterMs: number;
}

export interface EscalationHistoryEntry {
  step: number;
  appliedAt: string;
  resolvedTargetUserIds: string[];
}

export interface QuestionResponse {
  userId?: string;
  username?: string;
  byAgent: boolean;
  answer: string;
  at: string;
}

export interface Question {
  _id: string;
  question: string;
  options: string[];
  context?: string;
  todoId?: string;
  projectId?: string;
  /** T-390: customer-scoped questions */
  customerId?: string;
  /** T-390: originating Research Session */
  researchSessionId?: string;
  /** T-390: originating Chat Session */
  chatSessionId?: string;
  /** T-390: milestone-level decisions */
  milestoneId?: string;
  targetUserId?: string;
  /** T-393: role-based audience snapshot at create-time. */
  targetRole?: string;
  /** T-393: explicit "every project-scoped user" flag. */
  broadcast?: boolean;
  /** T-393: snapshot of resolved user ids at create or escalation time. */
  resolvedTargetUserIds?: string[];
  createdByUserId?: string;
  direction: QuestionDirection;
  status: QuestionStatus;
  answer?: string;
  answeredByUserId?: string;
  answeredByAgent?: boolean;
  answeredAt?: string;
  /** T-393: per-recipient response log. First entry wins for the legacy fields. */
  responses?: QuestionResponse[];
  agentRunId?: string;
  agentName?: string;
  timeoutMs: number;
  expiresAt?: string;
  knowledgeId?: string;
  /** T-391: Knowledge entry created via markAsDecision */
  decisionKnowledgeId?: string;
  /** T-391: Todo created via createFollowupTodo */
  followupTodoId?: string;
  /** T-394: when a snoozed question should wake up */
  snoozeUntil?: string;
  /** T-394: cancellation or supersede reason */
  closeReason?: string;
  /** T-394: replacement Question id when status=superseded */
  supersededByQuestionId?: string;
  escalationChain?: EscalationStep[];
  escalationStep?: number;
  escalationHistory?: EscalationHistoryEntry[];
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
