/**
 * OpenAI-compatible chat completion streaming client for the browser.
 *
 * Used by browser-mode chat where the user's own browser talks directly to
 * their local LLM server (e.g. LM Studio on the same machine), bypassing the
 * DevGrimoire backend so the local NPU/GPU can be used even when DevGrimoire
 * is hosted remotely.
 */

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
    throw new Error(`Connection failed: ${msg}`);
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
          parsed = JSON.parse(data) as OpenAiStreamChunk;
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
    const data = await res.json().catch(() => ({}));
    const models: string[] = Array.isArray(data?.data)
      ? (data.data as Array<{ id?: string }>).map((m) => m.id || '').filter(Boolean)
      : [];
    return { ok: true, models };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
