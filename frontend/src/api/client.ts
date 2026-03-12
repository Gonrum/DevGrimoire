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
  projectId: string;
  title: string;
  description?: string;
  status: 'open' | 'in_progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];
  milestoneId?: string;
  blockedBy: string[];
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
  projectId: string;
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

export interface UserInfo {
  _id: string;
  username: string;
  email?: string;
  role: 'admin' | 'user';
  active: boolean;
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
  createdAt: string;
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
  todos: {
    list: (filters?: { projectId?: string; status?: string }) => {
      const params = new URLSearchParams();
      if (filters?.projectId) params.set('projectId', filters.projectId);
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
    delete: (id: string) =>
      request<void>(`/api-keys/${id}`, { method: 'DELETE' }),
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
  profile: {
    get: () => request<UserInfo>('/auth/profile'),
    update: (data: { username?: string; email?: string }) =>
      request<UserInfo>('/auth/profile', { method: 'PATCH', body: JSON.stringify(data) }),
    changePassword: (oldPassword: string, newPassword: string) =>
      request<{ message: string }>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword, newPassword }),
      }),
  },
};
