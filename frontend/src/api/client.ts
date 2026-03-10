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

export interface SearchResult {
  type: 'todo' | 'knowledge' | 'changelog' | 'research' | 'milestone';
  id: string;
  projectId: string;
  title: string;
  snippet: string;
  status?: string;
  priority?: string;
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
    get: (projectId: string) =>
      request<Manual | null>(`/manuals?projectId=${projectId}`),
    save: (data: { projectId: string; content: string; title?: string }) =>
      request<Manual>('/manuals', { method: 'PUT', body: JSON.stringify(data) }),
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
