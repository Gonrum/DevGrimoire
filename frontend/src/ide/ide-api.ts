/**
 * The only module of the browser IDE that talks to the backend.
 *
 * All routes live under `/api/workspaces/:id/fs`. Unlike `request()` in
 * `api/client.ts`, errors keep their response body (a write conflict carries
 * `currentHash`), so this module issues its own requests but reuses the shared
 * token getter and the shared 401 refresh path from `client.ts`.
 */
import {
  getCurrentAccessToken,
  noteUnauthorizedStatus,
  refreshAccessTokenAfter401,
} from '../api/client';
import {
  parseJsonResponse,
  parseJsonText,
  readErrorMessage,
  readErrorMessageFromText,
} from '../api/http-boundary';
import { isRecord } from '../lib/narrow';

export interface IdeTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size?: number;
}
export interface IdeFile {
  path: string;
  content: string;
  hash: string;
  size: number;
}
export interface IdeSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}
export interface IdeGitStatus {
  branch: string | null;
  changed: { path: string; code: string }[];
}

export class IdeApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'IdeApiError';
  }
}

/** Thrown by `writeFile` on 409: the file changed on disk since `baseHash`. */
export class IdeConflictError extends IdeApiError {
  constructor(message: string, readonly currentHash: string | null) {
    super(message, 409);
    this.name = 'IdeConflictError';
  }
}

const BASE = '/api/workspaces';

function fsUrl(wsId: string, route: string, query?: Record<string, string>): string {
  const qs = query
    ? '?' + Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    : '';
  return `${BASE}/${encodeURIComponent(wsId)}/fs/${route}${qs}`;
}

function withAuth(headers: Record<string, string>): Record<string, string> {
  const token = getCurrentAccessToken();
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

/** fetch with Bearer header; on 401 refreshes the token and retries exactly once. */
async function authedFetch(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
  const send = () => fetch(url, { ...init, headers: withAuth(init.headers ?? {}) });
  let res = await send();
  if (res.status === 401) {
    if (await refreshAccessTokenAfter401()) res = await send();
    noteUnauthorizedStatus(res.status);
  }
  return res;
}

async function failFromResponse(res: Response): Promise<never> {
  throw new IdeApiError(await readErrorMessage(res), res.status);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await authedFetch(url, { method: 'GET' });
  if (!res.ok) return failFromResponse(res);
  return parseJsonResponse<T>(res);
}

async function sendJson<T>(url: string, method: string, body: unknown): Promise<T> {
  const res = await authedFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return failFromResponse(res);
  return parseJsonResponse<T>(res);
}

async function writeFile(
  wsId: string,
  path: string,
  content: string,
  opts: { baseHash: string | null; force?: boolean },
): Promise<{ hash: string }> {
  const res = await authedFetch(fsUrl(wsId, 'file'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    // baseHash must always be present (string or null); the backend rejects its absence.
    body: JSON.stringify({ path, content, baseHash: opts.baseHash, ...(opts.force ? { force: true } : {}) }),
  });
  if (res.status === 409) {
    const body: unknown = await res.json().catch(() => null);
    const message = isRecord(body) && typeof body.message === 'string' ? body.message : res.statusText;
    const currentHash = isRecord(body) && typeof body.currentHash === 'string' ? body.currentHash : null;
    throw new IdeConflictError(message, currentHash);
  }
  if (!res.ok) return failFromResponse(res);
  return parseJsonResponse<{ hash: string }>(res);
}

async function remove(wsId: string, path: string): Promise<void> {
  const res = await authedFetch(fsUrl(wsId, 'delete'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) return failFromResponse(res);
}

function xhrUpload(
  url: string,
  file: File,
  onProgress: ((fraction: number) => void) | undefined,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    const headers = withAuth({ 'Content-Type': 'application/octet-stream' });
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(new IdeApiError('Network error', 0));
    xhr.onabort = () => reject(new IdeApiError('Upload aborted', 0));
    xhr.send(file);
  });
}

async function upload(
  wsId: string,
  dir: string,
  file: File,
  opts?: { overwrite?: boolean; onProgress?: (fraction: number) => void },
): Promise<{ path: string; size: number }> {
  const url = fsUrl(wsId, 'upload', {
    dir,
    fileName: file.name,
    ...(opts?.overwrite ? { overwrite: '1' } : {}),
  });
  let result = await xhrUpload(url, file, opts?.onProgress);
  if (result.status === 401) {
    if (await refreshAccessTokenAfter401()) result = await xhrUpload(url, file, opts?.onProgress);
    noteUnauthorizedStatus(result.status);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new IdeApiError(readErrorMessageFromText(result.text) ?? `HTTP ${result.status}`, result.status);
  }
  return parseJsonText<{ path: string; size: number }>(result.text);
}

async function rawBlob(wsId: string, path: string): Promise<Blob> {
  const res = await authedFetch(fsUrl(wsId, 'raw', { path }), { method: 'GET' });
  if (!res.ok) return failFromResponse(res);
  return res.blob();
}

export const ideApi = {
  tree: (wsId: string, dir: string): Promise<{ entries: IdeTreeEntry[]; truncated: boolean }> =>
    getJson(fsUrl(wsId, 'tree', { path: dir })),
  readFile: (wsId: string, path: string): Promise<IdeFile> =>
    getJson(fsUrl(wsId, 'file', { path })),
  writeFile,
  mkdir: async (wsId: string, path: string): Promise<void> => {
    await sendJson<unknown>(fsUrl(wsId, 'mkdir'), 'POST', { path });
  },
  move: async (wsId: string, from: string, to: string): Promise<void> => {
    await sendJson<unknown>(fsUrl(wsId, 'move'), 'POST', { from, to });
  },
  remove,
  upload,
  rawBlob,
  search: (
    wsId: string,
    q: { query: string; regex: boolean; caseSensitive: boolean; include?: string[]; exclude?: string[] },
  ): Promise<{ matches: IdeSearchMatch[]; truncated: boolean }> =>
    sendJson(fsUrl(wsId, 'search'), 'POST', q),
  status: (wsId: string): Promise<IdeGitStatus> => getJson(fsUrl(wsId, 'status')),
};
