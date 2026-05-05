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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
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
  scope?: 'global' | 'project';
  topic: string;
  content: string;
  tags: string[];
  category?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  _id: string;
  projectId: string;
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
  projectId: string;
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
  projectId: string;
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
  projectId: string;
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
  projectId: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyInfo {
  _id: string;
  prefix: string;
  name: string;
  lastUsedAt?: string;
  expiresAt?: string;
  active: boolean;
  allowedTools?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyCreateResponse extends ApiKeyInfo {
  key: string;
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
  projectId: string;
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
  projectId: string;
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

export interface RecurringTask {
  _id: string;
  projectId: string;
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
  projectId: string;
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
    list: (filters?: { active?: boolean; favorite?: boolean }) => {
      const params = new URLSearchParams();
      if (filters?.active !== undefined) params.set('active', String(filters.active));
      if (filters?.favorite !== undefined) params.set('favorite', String(filters.favorite));
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
    list: (projectId: string) =>
      request<Knowledge[]>(`/knowledge?projectId=${projectId}`),
    search: (query: string, projectId?: string) => {
      const params = new URLSearchParams({ q: query });
      if (projectId) params.set('projectId', projectId);
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
      if (environmentId) params.set('environmentId', environmentId);
      return request<SecretListItem[]>(`/secrets?${params}`);
    },
    get: (id: string) => request<SecretWithValue>(`/secrets/${id}`),
    create: (data: { projectId: string; environmentId?: string; key: string; value: string; description?: string; type?: SecretType }) =>
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
  settings: {
    get: (key: string) =>
      request<{ key: string; value: string | null }>(`/settings/${key}`),
    set: (key: string, value: string) =>
      request<{ key: string; value: string }>(`/settings/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      }),
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
    create: (data: { name: string; expiresAt?: string }) =>
      request<ApiKeyCreateResponse>('/api-keys', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { name?: string; allowedTools?: string[] | null }) =>
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
    search: (query: string, projectId?: string) => {
      const params = new URLSearchParams({ q: query });
      if (projectId) params.set('projectId', projectId);
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
    upsert: (data: Partial<Soul> & { projectId: string }) =>
      request<Soul>('/souls', { method: 'PUT', body: JSON.stringify(data) }),
  },
  recurringTasks: {
    list: (filters?: { projectId?: string; systemOnly?: boolean; active?: boolean }) => {
      const params = new URLSearchParams();
      if (filters?.projectId) params.set('projectId', filters.projectId);
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
  attachments: {
    storageStatus: () =>
      request<{ enabled: boolean; bucket?: string }>('/attachments/storage-status'),
    list: (projectId: string, entityType?: string, entityId?: string) => {
      const params = new URLSearchParams({ projectId });
      if (entityType) params.set('entityType', entityType);
      if (entityId) params.set('entityId', entityId);
      return request<Attachment[]>(`/attachments?${params}`);
    },
    get: (id: string) => request<Attachment>(`/attachments/${id}`),
    upload: async (
      projectId: string,
      file: File,
      opts?: { entityType?: string; entityId?: string; description?: string; tags?: string },
    ) => {
      const headers: Record<string, string> = {};
      const token = getAccessToken?.();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const formData = new FormData();
      formData.append('file', file);
      formData.append('projectId', projectId);
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
  chat: {
    getConfig: () => request<ChatConfig>('/chat/config'),
    updateConfig: (data: Partial<ChatConfig>) =>
      request<ChatConfig>('/chat/config', { method: 'PUT', body: JSON.stringify(data) }),
    testEndpoint: (endpoint: ChatEndpoint) =>
      request<{ ok: boolean; error?: string; models?: string[] }>('/chat/config/test', {
        method: 'POST',
        body: JSON.stringify(endpoint),
      }),
    listSessions: (projectId: string, includeArchived = false) => {
      const params = new URLSearchParams({ projectId });
      if (includeArchived) params.set('includeArchived', 'true');
      return request<ChatSession[]>(`/chat/sessions?${params}`);
    },
    getSession: (id: string) => request<ChatSession>(`/chat/sessions/${id}`),
    createSession: (projectId: string, title?: string) =>
      request<ChatSession>('/chat/sessions', {
        method: 'POST',
        body: JSON.stringify({ projectId, title }),
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
                | { type: 'done'; reason?: string }
                | { type: 'error'; message: string };
              if (event.type === 'context') handlers.onContext?.(event.refs);
              else if (event.type === 'token') handlers.onToken?.(event.content);
              else if (event.type === 'tool_call') handlers.onToolCall?.({ id: event.id, name: event.name, arguments: event.arguments });
              else if (event.type === 'tool_result') handlers.onToolResult?.({ id: event.id, success: event.success, summary: event.summary });
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
};

export type ChatProvider =
  | 'lmstudio'
  | 'openai-compatible'
  | 'anthropic'
  | 'openai';

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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: string;
  contextUsed?: ChatContextRef[];
  toolCalls?: ChatToolCallRecord[];
  attachments?: ChatAttachmentRef[];
}

export interface ChatSession {
  _id: string;
  projectId: string;
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
