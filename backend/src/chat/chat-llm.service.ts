import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { EncryptionService } from '../common/encryption.service';
import { CHAT_PROVIDERS, ChatProvider, isLegacyProvider } from './dto/chat.dto';

export type LlmProvider = ChatProvider;

export interface LlmEndpoint {
  provider: LlmProvider;
  url: string;
  model: string;
  /** Optional API key. For openai/anthropic required; for lmstudio/openai-compatible optional; for ollama unused. */
  apiKey?: string;
  /**
   * Whether the configured model accepts images in the user message. We can't
   * auto-detect this (LM Studio doesn't expose capabilities, Ollama vision
   * support depends on the loaded model), so the admin opts in per endpoint.
   */
  visionCapable?: boolean;
}

/** Shape returned by config endpoints — API keys are never leaked. */
export interface LlmEndpointPublic {
  provider: LlmProvider;
  url: string;
  model: string;
  hasApiKey: boolean;
  visionCapable?: boolean;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Base64-encoded image payload attached to the most recent user message. */
export interface LlmImageInput {
  /** Raw base64 without the `data:` prefix. */
  data: string;
  /** MIME type, e.g. `image/jpeg`. */
  mediaType: string;
}

export interface LlmOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Optional images that get attached to the LAST user message. */
  images?: LlmImageInput[];
}

const SETTING_ENABLED = 'chat_enabled';
const SETTING_ENDPOINTS_V2 = 'chat_llm_endpoints_v2';
const SETTING_ENDPOINTS_LEGACY = 'chat_llm_endpoints';
const SETTING_TEMPERATURE = 'chat_llm_temperature';
const SETTING_MAX_TOKENS = 'chat_llm_max_tokens';
const SETTING_TOP_K = 'chat_llm_top_k';
const SETTING_HISTORY_LIMIT = 'chat_llm_history_limit';
const SETTING_TOOLS_ENABLED = 'chat_llm_tools_enabled';
const SETTING_TOOLS_ALLOWLIST = 'chat_llm_tools_allowlist';
const SETTING_TOOLS_MAX_ITERATIONS = 'chat_llm_tools_max_iterations';

const DEFAULT_TOOLS_ALLOWLIST = [
  'rag_search',
  'knowledge_search',
  'knowledge_get',
  'todo_list',
  'milestone_list',
];

/** Providers where tool-calling via OpenAI function-call protocol works today. */
const OPENAI_COMPATIBLE_PROVIDERS: ReadonlySet<LlmProvider> = new Set([
  'openai-compatible',
  'lmstudio',
  'openai',
]);

const ANTHROPIC_VERSION = '2023-06-01';

export interface OpenAiToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface LlmMessageWithTools {
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

export type ChatStreamEvent =
  | { type: 'content'; delta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' | 'other' };

/** Persisted shape of endpoints in the settings DB (apiKey is encrypted). */
interface StoredEndpoint {
  provider: LlmProvider;
  url: string;
  model: string;
  /** Encrypted ciphertext if a key was provided, otherwise undefined. */
  apiKeyEnc?: string;
  visionCapable?: boolean;
}

/**
 * Extract the first complete top-level JSON object from a string via bracket-
 * balanced scanning. Used to salvage streaming tool-call arguments when a
 * provider (Ollama) re-sends the full arguments on every delta chunk instead
 * of OpenAI's incremental protocol — our accumulator then holds `{...}{...}`
 * which no JSON.parse accepts. Returns `null` if no balanced object is found.
 * Handles strings and escapes so braces inside quoted values don't confuse
 * the depth counter.
 */
function extractFirstJsonObject(raw: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      if (start === -1) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Normalize a streaming tool-call arguments accumulator to a single valid JSON
 * string. Strips leading/trailing whitespace, extracts the first complete
 * top-level object if the input is concatenated JSON, falls back to `"{}"` on
 * total garbage so the dispatcher and replay paths never crash.
 */
export function normalizeToolCallArgs(raw: string | undefined | null): string {
  if (!raw || !raw.trim()) return '{}';
  const trimmed = raw.trim();
  // Fast path: already valid JSON object
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }
  } catch {
    /* fall through to bracket scan */
  }
  const first = extractFirstJsonObject(trimmed);
  if (first) {
    try {
      return JSON.stringify(JSON.parse(first));
    } catch {
      /* fall through */
    }
  }
  return '{}';
}

/** Thrown when images are supplied to a non-vision endpoint. */
export class NoVisionCapabilityError extends Error {
  readonly code = 'NO_VISION_CAPABILITY';
  constructor(public readonly endpoint: LlmEndpoint) {
    super(
      `Endpoint ${endpoint.provider} @ ${endpoint.url} (${endpoint.model}) is not marked as vision-capable. ` +
        `Enable "Vision-Modell" in Settings or switch to a vision provider.`,
    );
  }
}

@Injectable()
export class ChatLlmService {
  private readonly logger = new Logger(ChatLlmService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Resolve endpoints in order: Settings DB (JSON v2 or legacy CSV) → CHAT_LLM_ENDPOINTS env →
   * individual CHAT_LLM_* env vars. Decrypts API keys on the way out.
   */
  async getEndpoints(): Promise<LlmEndpoint[]> {
    const v2Raw = await this.settings.get(SETTING_ENDPOINTS_V2);
    if (v2Raw) {
      const { endpoints, migrated } = this.decodeStored(v2Raw);
      if (migrated) {
        // One-shot: overwrite the DB entry with the migrated form so the
        // legacy-provider path doesn't run on every read.
        this.logger.log('Auto-migrating stored chat endpoints to drop legacy ollama provider');
        await this.persistStored(endpoints.map((e) => this.toStored(e))).catch((err) => {
          this.logger.warn(`Persist-after-migrate failed: ${(err as Error).message}`);
        });
      }
      if (endpoints.length > 0) return endpoints;
    }

    const legacy = await this.settings.get(SETTING_ENDPOINTS_LEGACY);
    if (legacy) {
      const parsed = this.parseLegacyCsv(legacy);
      if (parsed.length > 0) {
        // One-shot migration: persist as v2 and drop legacy.
        await this.persistStored(parsed.map((e) => this.toStored(e)));
        await this.settings.set(SETTING_ENDPOINTS_LEGACY, '');
        return parsed;
      }
    }

    const envValue = process.env.CHAT_LLM_ENDPOINTS;
    if (envValue) {
      const parsed = this.parseLegacyCsv(envValue);
      if (parsed.length > 0) return parsed;
    }

    return this.endpointsFromLooseEnv();
  }

  /** Public-safe representation: strips API keys, replaces with hasApiKey flag. */
  async getEndpointsPublic(): Promise<LlmEndpointPublic[]> {
    const endpoints = await this.getEndpoints();
    return endpoints.map(({ apiKey, ...rest }) => ({
      provider: rest.provider,
      url: rest.url,
      model: rest.model,
      visionCapable: rest.visionCapable,
      hasApiKey: typeof apiKey === 'string' && apiKey.length > 0,
    }));
  }

  /**
   * Persist endpoints. `apiKey` semantics on each incoming endpoint:
   * - `undefined` → keep existing key if provider+url+model matches a previous entry
   * - `""` (empty string) → delete key
   * - any non-empty string → encrypt and store
   */
  async setEndpoints(incoming: LlmEndpoint[]): Promise<void> {
    const previous = await this.getEndpoints();
    const byKey = new Map(previous.map((e) => [this.endpointKey(e), e.apiKey ?? '']));

    const stored: StoredEndpoint[] = incoming.map((e) => {
      const merged: LlmEndpoint = { ...e };
      if (merged.apiKey === undefined) {
        // keep previous key if this endpoint matches an existing one
        const prevKey = byKey.get(this.endpointKey(merged));
        if (prevKey) merged.apiKey = prevKey;
      } else if (merged.apiKey === '') {
        // explicit delete
        delete merged.apiKey;
      }
      return this.toStored(merged);
    });

    await this.persistStored(stored);
  }

  private endpointKey(e: Pick<LlmEndpoint, 'provider' | 'url' | 'model'>): string {
    return `${e.provider}\u0000${e.url}\u0000${e.model}`;
  }

  private toStored(e: LlmEndpoint): StoredEndpoint {
    const stored: StoredEndpoint = {
      provider: e.provider,
      url: e.url,
      model: e.model,
    };
    if (e.visionCapable) stored.visionCapable = true;
    if (e.apiKey && e.apiKey.length > 0) {
      if (!this.encryption.isEnabled()) {
        throw new Error(
          'Cannot store API key: SECRETS_ENCRYPTION_KEY is not configured. ' +
            'Set it in .env before configuring cloud providers.',
        );
      }
      stored.apiKeyEnc = this.encryption.encrypt(e.apiKey);
    }
    return stored;
  }

  private decodeStored(raw: string): { endpoints: LlmEndpoint[]; migrated: boolean } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(`Malformed ${SETTING_ENDPOINTS_V2} JSON — ignoring`);
      return { endpoints: [], migrated: false };
    }
    if (!Array.isArray(parsed)) return { endpoints: [], migrated: false };

    const out: LlmEndpoint[] = [];
    let migrated = false;
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      let { provider } = entry as Partial<StoredEndpoint>;
      const { url, model, apiKeyEnc, visionCapable } = entry as Partial<StoredEndpoint>;

      // Transparent migration: legacy 'ollama' → 'openai-compatible'.
      // Ollama's /v1-shim has been stable since 0.3 and supports tools + vision,
      // so the native adapter is strictly inferior. URL stays the same — our
      // openai adapter appends /v1/chat/completions itself.
      if (typeof provider === 'string' && isLegacyProvider(provider)) {
        provider = 'openai-compatible';
        migrated = true;
      }

      if (!this.isValidProvider(provider) || !url || !model) continue;

      const ep: LlmEndpoint = { provider, url, model };
      if (visionCapable) ep.visionCapable = true;
      if (apiKeyEnc) {
        try {
          ep.apiKey = this.encryption.decrypt(apiKeyEnc);
        } catch (err) {
          this.logger.error(
            `Failed to decrypt API key for ${provider} @ ${url}: ${(err as Error).message}. ` +
              'Endpoint will run without a key — reconfigure from Settings UI.',
          );
        }
      }
      out.push(ep);
    }
    return { endpoints: out, migrated };
  }

  private async persistStored(stored: StoredEndpoint[]): Promise<void> {
    await this.settings.set(SETTING_ENDPOINTS_V2, JSON.stringify(stored));
  }

  private isValidProvider(value: unknown): value is LlmProvider {
    return typeof value === 'string' && (CHAT_PROVIDERS as readonly string[]).includes(value);
  }

  /** Legacy CSV format: `provider|url|model` (pre-v2, no API key). Applies the same
   *  legacy-provider migration as `decodeStored`. */
  private parseLegacyCsv(str: string): LlmEndpoint[] {
    return str
      .split(',')
      .map((entry) => {
        const [rawProvider, url, model] = entry.trim().split('|');
        const provider = (isLegacyProvider(rawProvider) ? 'openai-compatible' : rawProvider) as LlmProvider;
        return { provider, url, model };
      })
      .filter((e) => e.url && e.model && this.isValidProvider(e.provider));
  }

  /** Fallback when neither v2 nor CSV is set: single primary + optional fallback from loose env vars. */
  private endpointsFromLooseEnv(): LlmEndpoint[] {
    const rawProvider = process.env.CHAT_LLM_PROVIDER || 'openai-compatible';
    if (isLegacyProvider(rawProvider)) {
      this.logger.warn(
        `CHAT_LLM_PROVIDER=${rawProvider} is deprecated — mapped to 'openai-compatible'. ` +
          "Update your .env to use 'openai-compatible' against Ollama's /v1 shim.",
      );
    }
    const provider = (isLegacyProvider(rawProvider) ? 'openai-compatible' : rawProvider) as LlmProvider;
    const url = this.defaultUrlFor(provider, process.env.CHAT_LLM_URL);
    const model = process.env.CHAT_LLM_MODEL || 'google/gemma-3-4b';

    const primary: LlmEndpoint = { provider, url, model };
    if (process.env.CHAT_LLM_API_KEY) primary.apiKey = process.env.CHAT_LLM_API_KEY;

    const out: LlmEndpoint[] = [primary];

    const rawFbProvider = process.env.CHAT_LLM_FALLBACK_PROVIDER;
    if (rawFbProvider && isLegacyProvider(rawFbProvider)) {
      this.logger.warn(
        `CHAT_LLM_FALLBACK_PROVIDER=${rawFbProvider} is deprecated — mapped to 'openai-compatible'.`,
      );
    }
    const fbProvider = rawFbProvider
      ? (isLegacyProvider(rawFbProvider) ? 'openai-compatible' : rawFbProvider as LlmProvider)
      : undefined;
    const fbUrl = process.env.CHAT_LLM_FALLBACK_URL;
    const fbModel = process.env.CHAT_LLM_FALLBACK_MODEL;
    if (fbProvider && this.isValidProvider(fbProvider) && fbUrl && fbModel) {
      const fb: LlmEndpoint = { provider: fbProvider, url: fbUrl, model: fbModel };
      if (process.env.CHAT_LLM_FALLBACK_API_KEY) fb.apiKey = process.env.CHAT_LLM_FALLBACK_API_KEY;
      out.push(fb);
    }
    return out;
  }

  private defaultUrlFor(provider: LlmProvider, override?: string): string {
    if (override) return override;
    switch (provider) {
      case 'lmstudio':
        return 'http://localhost:1234';
      case 'anthropic':
        return 'https://api.anthropic.com';
      case 'openai':
        return 'https://api.openai.com';
      default:
        return 'http://localhost:1234';
    }
  }

  async getOptions(): Promise<{
    enabled: boolean;
    temperature: number;
    maxTokens: number;
    topK: number;
    historyLimit: number;
    toolsEnabled: boolean;
    toolsAllowlist: string[];
    toolsMaxIterations: number;
  }> {
    const [enabledStr, tempStr, maxStr, topKStr, histStr, toolsEn, toolsAllow, toolsMaxIter] = await Promise.all([
      this.settings.get(SETTING_ENABLED),
      this.settings.get(SETTING_TEMPERATURE),
      this.settings.get(SETTING_MAX_TOKENS),
      this.settings.get(SETTING_TOP_K),
      this.settings.get(SETTING_HISTORY_LIMIT),
      this.settings.get(SETTING_TOOLS_ENABLED),
      this.settings.get(SETTING_TOOLS_ALLOWLIST),
      this.settings.get(SETTING_TOOLS_MAX_ITERATIONS),
    ]);
    return {
      enabled: enabledStr != null ? enabledStr !== 'false' : process.env.CHAT_ENABLED !== 'false',
      temperature: tempStr != null ? parseFloat(tempStr) : parseFloat(process.env.CHAT_LLM_TEMPERATURE || '0.7'),
      maxTokens: maxStr != null ? parseInt(maxStr, 10) : parseInt(process.env.CHAT_LLM_MAX_TOKENS || '2048', 10),
      topK: topKStr != null ? parseInt(topKStr, 10) : parseInt(process.env.CHAT_LLM_TOP_K || '6', 10),
      historyLimit: histStr != null ? parseInt(histStr, 10) : parseInt(process.env.CHAT_LLM_HISTORY_LIMIT || '10', 10),
      toolsEnabled: toolsEn != null ? toolsEn === 'true' : process.env.CHAT_LLM_TOOLS_ENABLED === 'true',
      toolsAllowlist: toolsAllow != null
        ? toolsAllow.split(',').map((s) => s.trim()).filter(Boolean)
        : (process.env.CHAT_LLM_TOOLS_ALLOWLIST?.split(',').map((s) => s.trim()).filter(Boolean) ?? DEFAULT_TOOLS_ALLOWLIST),
      toolsMaxIterations: toolsMaxIter != null
        ? parseInt(toolsMaxIter, 10)
        : parseInt(process.env.CHAT_LLM_TOOLS_MAX_ITERATIONS || '5', 10),
    };
  }

  async isEnabled(): Promise<boolean> {
    const stored = await this.settings.get(SETTING_ENABLED);
    if (stored != null) return stored !== 'false';
    return process.env.CHAT_ENABLED !== 'false';
  }

  async setOptions(opts: {
    enabled?: boolean;
    temperature?: number;
    maxTokens?: number;
    topK?: number;
    historyLimit?: number;
    toolsEnabled?: boolean;
    toolsAllowlist?: string[];
    toolsMaxIterations?: number;
  }): Promise<void> {
    if (opts.enabled !== undefined) await this.settings.set(SETTING_ENABLED, String(opts.enabled));
    if (opts.temperature !== undefined) await this.settings.set(SETTING_TEMPERATURE, String(opts.temperature));
    if (opts.maxTokens !== undefined) await this.settings.set(SETTING_MAX_TOKENS, String(opts.maxTokens));
    if (opts.topK !== undefined) await this.settings.set(SETTING_TOP_K, String(opts.topK));
    if (opts.historyLimit !== undefined) await this.settings.set(SETTING_HISTORY_LIMIT, String(opts.historyLimit));
    if (opts.toolsEnabled !== undefined) await this.settings.set(SETTING_TOOLS_ENABLED, String(opts.toolsEnabled));
    if (opts.toolsAllowlist !== undefined) await this.settings.set(SETTING_TOOLS_ALLOWLIST, opts.toolsAllowlist.join(','));
    if (opts.toolsMaxIterations !== undefined) await this.settings.set(SETTING_TOOLS_MAX_ITERATIONS, String(opts.toolsMaxIterations));
  }

  async testEndpoint(endpoint: LlmEndpoint): Promise<{ ok: boolean; error?: string; models?: string[] }> {
    // If the request omits apiKey but we have one stored for this provider/url/model, use it.
    const effective = await this.resolveEffectiveKey(endpoint);
    const timeoutMs = 8000;
    try {
      if (effective.provider === 'anthropic') {
        return await this.testAnthropic(effective, timeoutMs);
      }
      return await this.testOpenAiCompatible(effective, timeoutMs);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** When testing from the UI, user may not re-enter the key → fall back to stored value. */
  private async resolveEffectiveKey(endpoint: LlmEndpoint): Promise<LlmEndpoint> {
    if (endpoint.apiKey) return endpoint;
    const all = await this.getEndpoints();
    const match = all.find((e) => this.endpointKey(e) === this.endpointKey(endpoint));
    if (match?.apiKey) return { ...endpoint, apiKey: match.apiKey };
    return endpoint;
  }

  private async testOpenAiCompatible(
    endpoint: LlmEndpoint,
    timeoutMs: number,
  ): Promise<{ ok: boolean; error?: string; models?: string[] }> {
    const headers: Record<string, string> = {};
    if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
    const res = await fetch(`${endpoint.url}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: `Auth failed (${res.status}) — API-Key prüfen` };
      }
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const models = Array.isArray(data.data) ? data.data.map((m) => m.id) : [];
    return { ok: true, models };
  }

  /**
   * Anthropic has no cheap "list models" endpoint; we do a minimal /v1/messages ping.
   * Uses 1 output token so cost is negligible.
   */
  private async testAnthropic(
    endpoint: LlmEndpoint,
    timeoutMs: number,
  ): Promise<{ ok: boolean; error?: string; models?: string[] }> {
    if (!endpoint.apiKey) {
      return { ok: false, error: 'Anthropic benötigt einen API-Key' };
    }
    const res = await fetch(`${endpoint.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': endpoint.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: endpoint.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      if (res.status === 401) return { ok: false, error: 'Auth failed (401) — API-Key prüfen' };
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 140)}` };
    }
    // Anthropic doesn't expose a generic models list; return the configured one.
    return { ok: true, models: [endpoint.model] };
  }

  /** Stream chat with tool-calling support. Only OpenAI-protocol endpoints support tools today. */
  async *streamChatWithTools(
    messages: LlmMessageWithTools[],
    tools: OpenAiToolDef[],
    options: LlmOptions = {},
  ): AsyncIterable<ChatStreamEvent> {
    const endpoints = await this.getEndpoints();
    if (endpoints.length === 0) throw new Error('No chat LLM endpoint configured');

    const settingsOpts = await this.getOptions();
    const resolved = {
      temperature: options.temperature ?? settingsOpts.temperature,
      maxTokens: options.maxTokens ?? settingsOpts.maxTokens,
      signal: options.signal,
      images: options.images,
    };
    const hasImages = !!resolved.images && resolved.images.length > 0;

    let lastErr: Error | null = null;
    for (const endpoint of endpoints) {
      if (!OPENAI_COMPATIBLE_PROVIDERS.has(endpoint.provider)) {
        this.logger.warn(
          `Skipping ${endpoint.provider} endpoint for tool-call request — tools currently only work with openai-protocol providers`,
        );
        continue;
      }
      if (hasImages && !endpoint.visionCapable) {
        this.logger.warn(
          `Skipping ${endpoint.provider} @ ${endpoint.url} — images supplied but endpoint not marked vision-capable`,
        );
        continue;
      }
      try {
        this.logger.log(
          `Chat stream (tools): ${endpoint.provider} @ ${endpoint.url} (${endpoint.model}) — ${tools.length} tools${hasImages ? ` + ${resolved.images!.length} image(s)` : ''}`,
        );
        yield* this.streamOpenAiWithTools(endpoint, messages, tools, resolved);
        return;
      } catch (err) {
        lastErr = err as Error;
        if (resolved.signal?.aborted) throw lastErr;
        this.logger.warn(
          `Chat endpoint failed (${endpoint.provider} @ ${endpoint.url}): ${lastErr.message}`,
        );
      }
    }
    if (hasImages && !lastErr) {
      throw new NoVisionCapabilityError(endpoints[0]);
    }
    throw lastErr ?? new Error('No tool-capable chat endpoint available (need openai-protocol provider)');
  }

  private async *streamOpenAiWithTools(
    endpoint: LlmEndpoint,
    messages: LlmMessageWithTools[],
    tools: OpenAiToolDef[],
    opts: { temperature: number; maxTokens: number; signal?: AbortSignal; images?: LlmImageInput[] },
  ): AsyncIterable<ChatStreamEvent> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;

    // Inject images into the most recent user message without breaking the
    // tool-call protocol message shape for the other turns.
    let outgoingMessages: unknown[] = messages;
    if (opts.images && opts.images.length > 0) {
      const clone = [...messages];
      for (let i = clone.length - 1; i >= 0; i--) {
        if (clone[i].role === 'user') {
          const original = clone[i];
          clone[i] = {
            ...original,
            content: [
              { type: 'text', text: original.content },
              ...opts.images.map((img) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${img.mediaType};base64,${img.data}` },
              })),
            ],
          } as unknown as LlmMessageWithTools;
          break;
        }
      }
      outgoingMessages = clone;
    }

    const res = await fetch(`${endpoint.url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: endpoint.model,
        messages: outgoingMessages,
        tools,
        tool_choice: 'auto',
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        stream: true,
      }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI-protocol API failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const toolCallAcc = new Map<number, { id: string; name: string; arguments: string }>();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'other' | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as {
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
            };
            const choice = parsed.choices?.[0];
            if (!choice) continue;
            if (choice.delta?.content) {
              yield { type: 'content', delta: choice.delta.content };
            }
            if (choice.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const existing = toolCallAcc.get(tc.index) ?? { id: '', name: '', arguments: '' };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                toolCallAcc.set(tc.index, existing);
              }
            }
            if (choice.finish_reason) {
              const r = choice.finish_reason;
              finishReason = r === 'stop' || r === 'tool_calls' || r === 'length' ? r : 'other';
            }
          } catch {
            /* malformed chunk */
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* noop */ }
    }

    const indices = Array.from(toolCallAcc.keys()).sort((a, b) => a - b);
    for (const idx of indices) {
      const tc = toolCallAcc.get(idx);
      if (tc && tc.id && tc.name) {
        // Providers like Ollama resend the full arguments on each delta chunk
        // instead of streaming deltas, so our accumulator can end up with
        // `{...}{...}`. normalizeToolCallArgs extracts the first balanced
        // JSON object to recover.
        const normalized = normalizeToolCallArgs(tc.arguments);
        if (normalized === '{}' && tc.arguments && tc.arguments.trim() !== '{}') {
          this.logger.debug(
            `tool_call ${tc.name} streaming accumulator unparseable (length=${tc.arguments.length}), falling back to "{}". Raw: ${tc.arguments.slice(0, 200)}`,
          );
        }
        yield { type: 'tool_call', id: tc.id, name: tc.name, arguments: normalized };
      }
    }

    yield { type: 'finish', reason: finishReason ?? 'other' };
  }

  /** Stream chat completion tokens, falling back across configured endpoints */
  async *streamChat(messages: LlmMessage[], options: LlmOptions = {}): AsyncIterable<string> {
    const endpoints = await this.getEndpoints();
    if (endpoints.length === 0) throw new Error('No chat LLM endpoint configured');

    const settingsOpts = await this.getOptions();
    const resolved = {
      temperature: options.temperature ?? settingsOpts.temperature,
      maxTokens: options.maxTokens ?? settingsOpts.maxTokens,
      signal: options.signal,
      images: options.images,
    };

    // If the caller provided images, skip endpoints that can't handle vision
    // rather than throwing immediately — we want to fall back to one that can.
    const hasImages = !!resolved.images && resolved.images.length > 0;
    const candidates = hasImages
      ? endpoints.filter((e) => e.visionCapable)
      : endpoints;
    if (candidates.length === 0) {
      if (hasImages) {
        throw new NoVisionCapabilityError(endpoints[0]);
      }
      throw new Error('No chat LLM endpoint configured');
    }

    let lastErr: Error | null = null;
    for (const endpoint of candidates) {
      try {
        this.logger.log(
          `Chat stream: ${endpoint.provider} @ ${endpoint.url} (${endpoint.model})${hasImages ? ` + ${resolved.images!.length} image(s)` : ''}`,
        );
        yield* this.streamFromEndpoint(endpoint, messages, resolved);
        return;
      } catch (err) {
        lastErr = err as Error;
        if (resolved.signal?.aborted) throw lastErr;
        this.logger.warn(
          `Chat endpoint failed (${endpoint.provider} @ ${endpoint.url}): ${lastErr.message}`,
        );
      }
    }
    throw lastErr ?? new Error('All chat endpoints failed');
  }

  private async *streamFromEndpoint(
    endpoint: LlmEndpoint,
    messages: LlmMessage[],
    opts: { temperature: number; maxTokens: number; signal?: AbortSignal; images?: LlmImageInput[] },
  ): AsyncIterable<string> {
    if (opts.images && opts.images.length > 0 && !endpoint.visionCapable) {
      throw new NoVisionCapabilityError(endpoint);
    }
    if (endpoint.provider === 'anthropic') {
      yield* this.streamAnthropic(endpoint, messages, opts);
    } else {
      yield* this.streamOpenAI(endpoint, messages, opts);
    }
  }

  /**
   * Build an OpenAI-compatible messages array. When images are present, the
   * LAST user message is converted from a plain string to a content array
   * that carries the image_url blocks alongside the text.
   */
  private buildOpenAiMessages(
    messages: LlmMessage[],
    images: LlmImageInput[] | undefined,
  ): Array<LlmMessage | { role: 'user'; content: Array<Record<string, unknown>> }> {
    if (!images || images.length === 0) return messages;
    const out: Array<LlmMessage | { role: 'user'; content: Array<Record<string, unknown>> }> = [];
    let injected = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!injected && m.role === 'user') {
        const parts: Array<Record<string, unknown>> = [
          { type: 'text', text: m.content },
          ...images.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType};base64,${img.data}` },
          })),
        ];
        out.unshift({ role: 'user', content: parts });
        injected = true;
      } else {
        out.unshift(m);
      }
    }
    return out;
  }

  private async *streamOpenAI(
    endpoint: LlmEndpoint,
    messages: LlmMessage[],
    opts: { temperature: number; maxTokens: number; signal?: AbortSignal; images?: LlmImageInput[] },
  ): AsyncIterable<string> {
    if (endpoint.provider === 'openai' && !endpoint.apiKey) {
      throw new Error('OpenAI-Provider benötigt einen API-Key');
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
    const res = await fetch(`${endpoint.url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: endpoint.model,
        messages: this.buildOpenAiMessages(messages, opts.images),
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        stream: true,
      }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI-protocol API failed (${res.status}): ${text.slice(0, 200)}`);
    }
    yield* this.parseSseStream(res.body, (data) => {
      if (data === '[DONE]') return null;
      try {
        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        return parsed.choices?.[0]?.delta?.content ?? '';
      } catch {
        return '';
      }
    });
  }

  /**
   * Anthropic Messages API (`/v1/messages`). System messages are extracted from the
   * array and concatenated into the top-level `system` field. SSE events of interest
   * are `content_block_delta` with `delta.type === 'text_delta'`.
   */
  private async *streamAnthropic(
    endpoint: LlmEndpoint,
    messages: LlmMessage[],
    opts: { temperature: number; maxTokens: number; signal?: AbortSignal; images?: LlmImageInput[] },
  ): AsyncIterable<string> {
    if (!endpoint.apiKey) throw new Error('Anthropic-Provider benötigt einen API-Key');

    const systemParts: string[] = [];
    type AnthropicContentBlock =
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
    type AnthropicMessage = {
      role: 'user' | 'assistant';
      content: string | AnthropicContentBlock[];
    };
    const body: AnthropicMessage[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        if (m.content) systemParts.push(m.content);
      } else {
        body.push({ role: m.role, content: m.content });
      }
    }
    // Attach images to the last user message as content blocks.
    if (opts.images && opts.images.length > 0) {
      for (let i = body.length - 1; i >= 0; i--) {
        if (body[i].role === 'user') {
          const original = body[i].content;
          const textBlock: AnthropicContentBlock = {
            type: 'text',
            text: typeof original === 'string' ? original : '',
          };
          const imageBlocks: AnthropicContentBlock[] = opts.images.map((img) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
          }));
          body[i] = { role: 'user', content: [textBlock, ...imageBlocks] };
          break;
        }
      }
    }
    // Anthropic requires a non-empty messages array with alternating user/assistant,
    // starting with user. The ChatContext pipeline already produces that shape for us;
    // if the first entry is accidentally `assistant`, prepend an empty user turn so the
    // request doesn't 400.
    if (body.length === 0) body.push({ role: 'user', content: '' });
    if (body[0].role !== 'user') body.unshift({ role: 'user', content: '' });

    const res = await fetch(`${endpoint.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': endpoint.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: endpoint.model,
        system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
        messages: body,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        stream: true,
      }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API failed (${res.status}): ${text.slice(0, 200)}`);
    }

    yield* this.parseSseStream(res.body, (data) => {
      try {
        const parsed = JSON.parse(data) as {
          type?: string;
          delta?: { type?: string; text?: string };
        };
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          return parsed.delta.text ?? '';
        }
        // Ignore message_start/stop/ping/message_delta etc. for plain streaming
        return '';
      } catch {
        return '';
      }
    });
  }

  private async *parseSseStream(
    body: ReadableStream<Uint8Array>,
    extract: (data: string) => string | null,
  ): AsyncIterable<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          const text = extract(data);
          if (text === null) return;
          if (text) yield text;
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

}
