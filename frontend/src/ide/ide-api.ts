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
import { parseJsonResponse, parseJsonText, readErrorMessageFromText } from '../api/http-boundary';
import { isRecord, isUnknownArray } from '../lib/narrow';

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

/**
 * Why a request answered 409. Three different things share the status:
 * - `conflict`: write conflict, the body carries `currentHash` (see `writeFile`)
 * - `exists`:   the sidecar refused to overwrite (`target exists` / `already exists`)
 * - `inactive`: the backend gate's ConflictException — the workspace is not active
 */
export type IdeConflictReason = 'conflict' | 'exists' | 'inactive';

export class IdeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Set for status 409 only. */
    readonly reason?: IdeConflictReason,
    /** Set for status 413 when the backend names the limit in force (bytes). */
    readonly limit?: number,
  ) {
    super(message);
    this.name = 'IdeApiError';
  }
}

/** Thrown by `writeFile` on 409: the file changed on disk since `baseHash`. */
export class IdeConflictError extends IdeApiError {
  constructor(message: string, readonly currentHash: string | null) {
    super(message, 409, 'conflict');
    this.name = 'IdeConflictError';
  }
}

/** The one place that tells the three kinds of 409 apart. */
function conflictReason(body: unknown): IdeConflictReason {
  if (!isRecord(body)) return 'inactive';
  if ('currentHash' in body) return 'conflict';
  if (typeof body.error === 'string' && /\bexists$/.test(body.error)) return 'exists';
  return 'inactive';
}

/** Error body as an unknown value; null when it is empty or not JSON. */
function parseErrorBody(text: string): unknown {
  try {
    return parseJsonText<unknown>(text);
  } catch {
    return null;
  }
}

/** IdeApiError from a failed response's status and body text. */
function errorFromText(status: number, text: string, fallback: string): IdeApiError {
  const body = parseErrorBody(text);
  // Nest reports DTO validation failures as a string array in `message`.
  const lines = isRecord(body) && isUnknownArray(body.message)
    ? body.message.filter((m): m is string => typeof m === 'string' && m.length > 0)
    : [];
  const message = readErrorMessageFromText(text) ?? (lines.length > 0 ? lines.join('; ') : fallback);
  const limit = status === 413 && isRecord(body) && typeof body.limit === 'number' ? body.limit : undefined;
  return new IdeApiError(message, status, status === 409 ? conflictReason(body) : undefined, limit);
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
  const text = await res.text().catch(() => '');
  throw errorFromText(res.status, text, res.statusText);
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
    const text = await res.text().catch(() => '');
    const body = parseErrorBody(text);
    // A write conflict always carries `currentHash` (null when the file is gone). A 409
    // without it is the gate's "workspace is not active" and must not look like a conflict.
    if (!isRecord(body) || conflictReason(body) !== 'conflict') throw errorFromText(409, text, res.statusText);
    const message = readErrorMessageFromText(text) ?? res.statusText;
    const currentHash = typeof body.currentHash === 'string' ? body.currentHash : null;
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
    throw errorFromText(result.status, result.text, `HTTP ${result.status}`);
  }
  return parseJsonText<{ path: string; size: number }>(result.text);
}

/**
 * Preview only (image tabs): loads a file into memory, but only when the
 * server announces a size within `maxBytes`. Anything else resolves to
 * `null` without reading the body, so a stale size hint can never pull a
 * huge file into the page. Real downloads use `startDownload`.
 */
async function previewBlob(wsId: string, path: string, maxBytes: number): Promise<Blob | null> {
  const res = await authedFetch(fsUrl(wsId, 'raw', { path }), { method: 'GET' });
  if (!res.ok) return failFromResponse(res);
  const length = Number(res.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0 || length > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  return res.blob();
}

/**
 * Download without buffering in the page: asks for a one-time URL (this
 * request is authenticated and fails with 404/413 like any other), then lets
 * the browser fetch it natively. The response is `Content-Disposition:
 * attachment`, so the IDE page stays and the browser streams the file to disk.
 */
async function startDownload(wsId: string, path: string, fileName: string): Promise<void> {
  const { url } = await sendJson<{ url: string }>(fsUrl(wsId, 'download-ticket'), 'POST', { path });
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
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
  previewBlob,
  startDownload,
  search: (
    wsId: string,
    q: { query: string; regex: boolean; caseSensitive: boolean; include?: string[]; exclude?: string[] },
  ): Promise<{ matches: IdeSearchMatch[]; truncated: boolean }> =>
    sendJson(fsUrl(wsId, 'search'), 'POST', q),
  status: (wsId: string): Promise<IdeGitStatus> => getJson(fsUrl(wsId, 'status')),
};
