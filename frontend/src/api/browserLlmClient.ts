/**
 * OpenAI-compatible chat completion streaming client for the browser.
 *
 * Used by browser-mode chat where the user's own browser talks directly to
 * their local LLM server (e.g. LM Studio on the same machine), bypassing the
 * DevGrimoire backend so the local NPU/GPU can be used even when DevGrimoire
 * is hosted remotely.
 */

import { parseJsonResponse, parseJsonText } from './http-boundary';

export interface BrowserLlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface BrowserLlmTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export type BrowserLlmFinishReason = 'stop' | 'tool_calls' | 'length' | 'other';

export type BrowserLlmEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'finish'; reason: BrowserLlmFinishReason };

export interface BrowserLlmRequest {
  endpoint: string;
  model: string;
  apiKey?: string;
  messages: BrowserLlmMessage[];
  tools?: BrowserLlmTool[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
}

function buildUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return `${base}/v1/chat/completions`;
}

function normalizeFinishReason(reason: string | undefined): BrowserLlmFinishReason {
  if (reason === 'stop' || reason === 'tool_calls' || reason === 'length') return reason;
  return 'other';
}

/**
 * Extract the first balanced top-level JSON object from a string. Used to
 * recover tool-call arguments when a provider (e.g. Ollama) re-sends the
 * complete args on each streaming delta instead of incrementing them, which
 * leaves our accumulator with `{...}{...}`. Mirrors the backend helper.
 */
function extractFirstJsonObject(raw: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') {
      if (start === -1) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeToolCallArgs(raw: string | undefined | null): string {
  if (!raw || !raw.trim()) return '{}';
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }
  } catch { /* fall through */ }
  const first = extractFirstJsonObject(trimmed);
  if (first) {
    try { return JSON.stringify(JSON.parse(first)); } catch { /* fall through */ }
  }
  return '{}';
}

/**
 * Stream tokens from an OpenAI-compatible /v1/chat/completions endpoint.
 * Yields content tokens, accumulated tool calls, and a final finish event.
 */
export async function* streamBrowserLlm(req: BrowserLlmRequest): AsyncGenerator<BrowserLlmEvent> {
  if (!req.endpoint?.trim()) {
    throw new Error('endpoint is required');
  }
  if (!req.model?.trim()) {
    throw new Error('model is required');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (req.apiKey) {
    headers.Authorization = `Bearer ${req.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: true,
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools;
    body.tool_choice = 'auto';
  }
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (typeof req.maxTokens === 'number') body.max_tokens = req.maxTokens;

  let res: Response;
  try {
    res = await fetch(buildUrl(req.endpoint), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (err) {
    // fetch throws on network errors (DNS, CORS, mixed-content, refused)
    const msg = err instanceof Error ? err.message : String(err);
    // Der gefangene Fehler bleibt als `cause` erhalten (ohne ihn wäre nur noch
    // die Textmeldung da, kein Stacktrace der Netzwerkschicht).
    //
    // Warum nicht `new Error(msg, { cause: err })`: die tsconfig fährt
    // `lib: ["ES2020", …]`, und `ErrorOptions` kommt erst mit `ES2022.Error`.
    // Das zweite Konstruktor-Argument ist dort schlicht nicht typisiert. Zur
    // Laufzeit ist das Setzen danach identisch.
    const wrapped: Error & { cause?: unknown } = new Error(`Connection failed: ${msg}`);
    wrapped.cause = err;
    throw wrapped;
  }

  if (!res.ok || !res.body) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`LLM API returned ${res.status}: ${detail.slice(0, 200) || res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: BrowserLlmFinishReason | null = null;
  const toolCallAcc = new Map<number, { id: string; name: string; arguments: string }>();

  try {
    while (true) {
      if (req.signal?.aborted) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let parsed: OpenAiStreamChunk;
        try {
          // Ein defektes Frame wird verworfen, der Stream läuft weiter.
          parsed = parseJsonText<OpenAiStreamChunk>(data);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;

        if (choice.delta?.content) {
          yield { type: 'token', content: choice.delta.content };
        }
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const acc = toolCallAcc.get(tc.index) ?? { id: '', name: '', arguments: '' };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            toolCallAcc.set(tc.index, acc);
          }
        }
        if (choice.finish_reason) {
          finishReason = normalizeFinishReason(choice.finish_reason);
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  const indices = Array.from(toolCallAcc.keys()).sort((a, b) => a - b);
  for (const idx of indices) {
    const tc = toolCallAcc.get(idx);
    if (tc && tc.id && tc.name) {
      // Recover from providers that resend full arguments per delta (Ollama),
      // leaving the accumulator with `{...}{...}`.
      yield { type: 'tool_call', id: tc.id, name: tc.name, arguments: normalizeToolCallArgs(tc.arguments) };
    }
  }

  yield { type: 'finish', reason: finishReason ?? 'other' };
}

/**
 * `Array.isArray` verengt `unknown` zu `any[]` und liefert damit wieder `any` —
 * dieses Prädikat verengt zu `unknown[]`, sodass jedes Element geprüft werden muss.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Model-IDs aus einer `/v1/models`-Antwort lesen, ohne der Form zu trauen — der
 * Endpunkt gehört dem Nutzer, nicht uns, und muss nicht OpenAI-konform antworten.
 * Alles, was nicht `{ data: [{ id: string }, …] }` ist, ergibt eine leere Liste.
 */
function readModelIds(body: unknown): string[] {
  if (body === null || typeof body !== 'object' || !('data' in body)) return [];
  const data: unknown = body.data;
  if (!isUnknownArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object' || !('id' in entry)) continue;
    const id: unknown = entry.id;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  return ids;
}

/**
 * Quick reachability test against /v1/models. Used by Settings UI to verify
 * the user's endpoint configuration before they save.
 */
export async function testBrowserLlmEndpoint(
  endpoint: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  if (!endpoint?.trim()) {
    return { ok: false, error: 'endpoint is required' };
  }
  const base = endpoint.replace(/\/+$/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const res = await fetch(`${base}/v1/models`, { headers, signal });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const body = await parseJsonResponse<unknown>(res).catch(() => null);
    return { ok: true, models: readModelIds(body) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
