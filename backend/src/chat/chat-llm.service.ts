import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { EncryptionService } from '../common/encryption.service';
import { BalancerGateway } from '../balancer/balancer-gateway.service';
import { readModelIds } from '../balancer/llm-responses';
import { errorMessage, isRecord, isUnknownArray } from '../common/narrow';
import { asString } from '../common/tool-args';
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
  /**
   * Invoked once per actual call (after fallback resolution) with the endpoint
   * the request was sent to. Used by chat-activity logging so we know which
   * endpoint failed/succeeded without parsing log lines.
   */
  onEndpointSelected?: (endpoint: { provider: LlmProvider; url: string; model: string }) => void;
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

// Default chat tool allowlist. Read-only across customer + project + task
// domains so the assistant can answer typical questions without write power.
// Customer-specific writes (customer_update, contact_create, secret_set, ...)
// stay off by default and require explicit admin opt-in.
const DEFAULT_TOOLS_ALLOWLIST = [
  // Knowledge & search
  'rag_search',
  'knowledge_search',
  'knowledge_get',
  // Task management (read)
  'todo_list',
  'milestone_list',
  // Customer context (read-only)
  'customer_list',
  'customer_get',
  'contact_list',
  'contact_get',
  'customer_project_list',
  'project_customer_links',
  // Stacks (read + write; stack_delete stays permanently blocked)
  'stack_list',
  'stack_get',
  'stack_export_markdown',
  'stack_create',
  'stack_update',
  'stack_entry_add',
  'stack_entry_update',
  'stack_entry_remove',
];

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
    private readonly gateway: BalancerGateway,
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
        await this.persistStored(endpoints.map((e) => this.toStored(e))).catch((err: unknown) => {
          this.logger.warn(`Persist-after-migrate failed: ${errorMessage(err)}`);
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
    // `isUnknownArray` statt `Array.isArray`: letzteres verengt ein `unknown` zu
    // `any[]`, und jedes `entry.*` unten wäre wieder ein ungeprüfter any-Zugriff.
    if (!isUnknownArray(parsed)) return { endpoints: [], migrated: false };

    const out: LlmEndpoint[] = [];
    let migrated = false;
    for (const entry of parsed) {
      if (!isRecord(entry)) continue;
      const rawProvider = asString(entry.provider);
      const url = asString(entry.url);
      const model = asString(entry.model);

      // Transparent migration: legacy 'ollama' → 'openai-compatible'.
      // Ollama's /v1-shim has been stable since 0.3 and supports tools + vision,
      // so the native adapter is strictly inferior. URL stays the same — our
      // openai adapter appends /v1/chat/completions itself.
      if (rawProvider !== undefined && isLegacyProvider(rawProvider)) migrated = true;
      const provider = this.toProvider(rawProvider);

      if (!provider || !url || !model) continue;

      const ep: LlmEndpoint = { provider, url, model };
      if (entry.visionCapable) ep.visionCapable = true;
      const apiKeyEnc = asString(entry.apiKeyEnc);
      if (apiKeyEnc) {
        try {
          ep.apiKey = this.encryption.decrypt(apiKeyEnc);
        } catch (err: unknown) {
          this.logger.error(
            `Failed to decrypt API key for ${provider} @ ${url}: ${errorMessage(err)}. ` +
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

  /**
   * Provider-String → Provider-Typ, oder `undefined` wenn unbekannt.
   *
   * Die eine Stelle, an der ein gespeicherter oder aus der Umgebung gelesener
   * String zum `LlmProvider` wird. `find()` liefert `ChatProvider | undefined`
   * — der enge Typ entsteht damit aus einer echten Laufzeitprüfung statt aus
   * einem `as LlmProvider`, das vorher an drei Stellen stand und ungeprüfte
   * Strings (`CHAT_LLM_PROVIDER=tippfehler`) als Provider durchließ.
   */
  private toProvider(value: string | undefined): LlmProvider | undefined {
    if (value === undefined || value === '') return undefined;
    if (isLegacyProvider(value)) return 'openai-compatible';
    return CHAT_PROVIDERS.find((candidate) => candidate === value);
  }

  /** Legacy CSV format: `provider|url|model` (pre-v2, no API key). Applies the same
   *  legacy-provider migration as `decodeStored`. */
  private parseLegacyCsv(str: string): LlmEndpoint[] {
    const out: LlmEndpoint[] = [];
    for (const entry of str.split(',')) {
      const [rawProvider, url, model] = entry.trim().split('|');
      const provider = this.toProvider(rawProvider);
      if (!provider || !url || !model) continue;
      out.push({ provider, url, model });
    }
    return out;
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
    // Ein unbekannter Provider-String fiel vorher ungeprüft durch und landete
    // als `LlmProvider` im Endpunkt; die Adapter behandeln alles außer
    // `anthropic` ohnehin als OpenAI-kompatibel — der Fallback macht das
    // sichtbar, statt den Tippfehler weiterzutragen.
    const provider = this.toProvider(rawProvider) ?? 'openai-compatible';
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
    const fbProvider = this.toProvider(rawFbProvider);
    const fbUrl = process.env.CHAT_LLM_FALLBACK_URL;
    const fbModel = process.env.CHAT_LLM_FALLBACK_MODEL;
    if (fbProvider && fbUrl && fbModel) {
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
    } catch (err: unknown) {
      // Hier landen Timeouts und Verbindungsabbrüche des Endpunkt-Tests —
      // `(err as Error).message` hätte dem Admin "undefined" angezeigt.
      return { ok: false, error: errorMessage(err) };
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
    // Derselbe Leser wie in `balancer/llm-endpoints.service.ts` — die
    // Modell-Liste wurde vorher zweimal unabhängig per Assertion gelesen.
    return { ok: true, models: readModelIds(await res.json()) };
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

  /**
   * Stream chat with tool-calling support for ONE turn. Routes through the LLM
   * balancer queue: a worker leases a chat-pool slot and streams this turn. The
   * chat controller runs tools between turns and re-invokes for the next turn.
   */
  async *streamChatWithTools(
    messages: LlmMessageWithTools[],
    tools: OpenAiToolDef[],
    options: LlmOptions = {},
  ): AsyncIterable<ChatStreamEvent> {
    const settingsOpts = await this.getOptions();
    const temperature = options.temperature ?? settingsOpts.temperature;
    const maxTokens = options.maxTokens ?? settingsOpts.maxTokens;
    yield* this.gateway.runChat({
      withTools: true,
      messages,
      tools,
      temperature,
      maxTokens,
      images: options.images,
      requireVision: !!options.images?.length,
      signal: options.signal,
    });
  }

  /**
   * Stream plain chat completion tokens. Routes through the LLM balancer queue,
   * which leases a chat-pool slot, streams the turn, and relays content deltas.
   */
  async *streamChat(messages: LlmMessage[], options: LlmOptions = {}): AsyncIterable<string> {
    const settingsOpts = await this.getOptions();
    const temperature = options.temperature ?? settingsOpts.temperature;
    const maxTokens = options.maxTokens ?? settingsOpts.maxTokens;
    for await (const ev of this.gateway.runChat({
      withTools: false,
      messages,
      temperature,
      maxTokens,
      images: options.images,
      requireVision: !!options.images?.length,
      signal: options.signal,
    })) {
      if (ev.type === 'content') yield ev.delta;
    }
  }
}
