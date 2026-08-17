import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import * as lancedb from '@lancedb/lancedb';
import * as path from 'path';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';
import { SettingsService } from '../settings/settings.service';
import { EncryptionService } from '../common/encryption.service';
import { RequestContext } from '../common/request-context';
import { ALL_SENSITIVITY_LEVELS, isExcludedFromRag, SensitivityLevel } from '../common/sensitivity';
import { BalancerGateway } from '../balancer/balancer-gateway.service';

const SETTING_RAG_ENDPOINTS_V1 = 'rag_embedding_endpoints_v1';

interface StoredEndpoint {
  provider: string;
  url: string;
  model: string;
  apiKeyEnc?: string;
}

/** Entity types that contain indexable text content */
const INDEXABLE_ENTITIES = [
  'knowledge',
  'research',
  'manual',
  'changelog',
  'todo',
  'session',
  'snippet',
  'attachment',
  'schema',
  'project',
  'question',
  'research_artifact',
] as const;

type IndexableEntity = (typeof INDEXABLE_ENTITIES)[number];

/** MongoDB collection names for each entity */
const ENTITY_COLLECTION_MAP: Record<IndexableEntity, string> = {
  knowledge: 'knowledges',
  research: 'researches',
  manual: 'manuals',
  changelog: 'changelogs',
  todo: 'todos',
  session: 'sessions',
  snippet: 'snippets',
  attachment: 'attachments',
  schema: 'dbschemas',
  project: 'projects',
  question: 'questions',
  research_artifact: 'researchartifacts',
};

interface RagDocument {
  [key: string]: unknown;
  id: string;
  sourceId: string;
  chunkIndex: number;
  projectId: string;
  customerId: string;
  entity: string;
  title: string;
  content: string;
  vector: number[];
}

/** A single deduplicated (per source document) semantic search result. */
export interface RagSearchHit {
  id: string;
  projectId: string;
  customerId: string;
  entity: string;
  title: string;
  content: string;
  score: number;
}

/**
 * A row as it comes back from LanceDB. The driver types `toArray()` as
 * `any[]`, so every read is funnelled through `RagService.queryRows()` and
 * enters our code as unknown-valued records instead of `any`.
 */
type LanceRow = Record<string, unknown>;

/** Narrowing helper: a plain object with unknown-typed members. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrowing helper: an array whose element type is not known yet. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Mongo `ObjectId` (or anything else handing out a hex id) — structural check
 * so this module doesn't have to import the driver just to test a field.
 */
function isObjectIdLike(value: unknown): value is { toHexString: () => string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toHexString' in value &&
    typeof value.toHexString === 'function'
  );
}

/**
 * Convert a raw Mongo/LanceDB field value into text worth embedding.
 *
 * Only values with a meaningful string form are accepted. Plain objects and
 * arrays are deliberately dropped instead of stringified: `String({})` yields
 * `[object Object]`, and that string would become part of the embedded text —
 * making the affected index entry useless for semantic search without
 * anything ever failing loudly. Array fields go through `asTextList` instead.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  if (isObjectIdLike(value)) return value.toHexString();
  return '';
}

/** `asText` for array fields — non-text elements are dropped, not stringified. */
function asTextList(value: unknown): string[] {
  if (!isUnknownArray(value)) return [];
  return value.map((item) => asText(item).trim()).filter((item) => item.length > 0);
}

/** Finite numbers only — NaN, strings and undefined all become undefined. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Message of an unknown throwable, without stringifying non-Error objects. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  // Non-Error throwables from native bindings / HTTP clients still carry a
  // usable message — keep it instead of logging a placeholder.
  if (isRecord(err) && typeof err.message === 'string') return err.message;
  return 'unknown error';
}

function isSensitivityLevel(value: unknown): value is SensitivityLevel {
  return typeof value === 'string' && (ALL_SENSITIVITY_LEVELS as readonly string[]).includes(value);
}

function isIndexableEntity(value: string): value is IndexableEntity {
  return (INDEXABLE_ENTITIES as readonly string[]).includes(value);
}

/**
 * Pure merge helper for `searchScopes`: takes one hit list per scope (project,
 * customer, global), dedupes by source document id (keeping the highest
 * score per id), sorts by score descending, and truncates to `limit`.
 * Kept free of LanceDB/Mongo dependencies so it can be unit-tested directly.
 */
export function mergeScopeHits(hitLists: RagSearchHit[][], limit: number): RagSearchHit[] {
  const seen = new Map<string, RagSearchHit>();
  for (const hits of hitLists) {
    for (const hit of hits) {
      const existing = seen.get(hit.id);
      if (!existing || hit.score > existing.score) {
        seen.set(hit.id, hit);
      }
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

type EmbeddingProvider = 'ollama' | 'openai-compatible';
const EMBEDDING_PROVIDERS: readonly EmbeddingProvider[] = ['ollama', 'openai-compatible'] as const;

interface EmbeddingEndpoint {
  provider: EmbeddingProvider;
  url: string;
  model: string;
  apiKey?: string;
}

export interface EmbeddingEndpointPublic {
  provider: EmbeddingProvider;
  url: string;
  model: string;
  hasApiKey: boolean;
}

/**
 * Unvalidated endpoint as it arrives from the REST body. `provider` is a plain
 * string on purpose — the value is whatever the client sent and only becomes
 * an `EmbeddingProvider` after `isValidProvider()` has vouched for it.
 */
export interface EmbeddingEndpointInput {
  provider: string;
  url: string;
  model: string;
  /** undefined → keep existing key for matching endpoint; "" → delete; otherwise → encrypt+store. */
  apiKey?: string;
}

export interface EmbeddingEndpointTestResult {
  ok: boolean;
  dimensions?: number;
  latencyMs?: number;
  error?: string;
}

@Injectable()
export class RagService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RagService.name);
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private dimensions = 0;
  private embeddingModel = '';
  private embeddingUrl = '';
  private embeddingProvider: EmbeddingProvider = 'ollama';
  private endpoints: EmbeddingEndpoint[] = [];
  private ready = false;
  private initPromise: Promise<void> | null = null;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly settings: SettingsService,
    private readonly encryption: EncryptionService,
    private readonly gateway: BalancerGateway,
  ) {}

  onModuleInit(): void {
    this.initPromise = this.initialize();
    // Deliberately not awaited — let the app start even if the embedding server
    // is unavailable. `initPromise` is awaited later by `ensureReady()`.
    this.initPromise.catch((err: unknown) => {
      this.logger.warn(`RAG initialization failed: ${errorMessage(err)}. RAG features disabled.`);
    });
  }

  onModuleDestroy(): void {
    // Release the native LanceDB handles instead of only dropping the
    // references — the Rust side keeps the dataset open otherwise.
    try {
      if (this.table?.isOpen()) this.table.close();
      if (this.db?.isOpen()) this.db.close();
    } catch (err) {
      this.logger.warn(`Closing LanceDB failed: ${errorMessage(err)}`);
    }
    this.db = null;
    this.table = null;
    this.ready = false;
  }

  /**
   * Resolve embedding endpoints. Priority:
   *   1. Settings DB (`rag_embedding_endpoints_v1`) — managed via UI
   *   2. RAG_ENDPOINTS env (CSV `provider|url|model`)
   *   3. RAG_EMBEDDING_* + RAG_FALLBACK_* env (single + optional fallback)
   *   4. Defaults (Ollama localhost)
   */
  private async loadEndpoints(): Promise<EmbeddingEndpoint[]> {
    const dbRaw = await this.settings.get(SETTING_RAG_ENDPOINTS_V1);
    if (dbRaw) {
      const decoded = this.decodeStored(dbRaw);
      if (decoded.length > 0) return decoded;
      this.logger.warn(`${SETTING_RAG_ENDPOINTS_V1} stored but empty/malformed — falling back to env`);
    }
    return this.endpointsFromEnv();
  }

  private endpointsFromEnv(): EmbeddingEndpoint[] {
    const endpointsStr = process.env.RAG_ENDPOINTS;
    if (endpointsStr) {
      return endpointsStr
        .split(',')
        .map((entry) => {
          const [provider, url, model] = entry.trim().split('|');
          return { provider: provider as EmbeddingProvider, url, model };
        })
        .filter((e) => this.isValidProvider(e.provider) && e.url && e.model);
    }

    const provider = (process.env.RAG_EMBEDDING_PROVIDER || 'ollama') as EmbeddingProvider;
    const model = process.env.RAG_EMBEDDING_MODEL || 'nomic-embed-text';
    const url = provider === 'openai-compatible'
      ? (process.env.RAG_EMBEDDING_URL || 'http://localhost:1234')
      : (process.env.OLLAMA_URL || 'http://localhost:11434');

    const primary: EmbeddingEndpoint = { provider, url, model };
    if (process.env.RAG_EMBEDDING_API_KEY) primary.apiKey = process.env.RAG_EMBEDDING_API_KEY;
    const endpoints = [primary];

    const fallbackProvider = process.env.RAG_FALLBACK_PROVIDER as EmbeddingProvider | undefined;
    const fallbackUrl = process.env.RAG_FALLBACK_URL;
    const fallbackModel = process.env.RAG_FALLBACK_MODEL;
    if (fallbackProvider && fallbackUrl && fallbackModel && this.isValidProvider(fallbackProvider)) {
      const fb: EmbeddingEndpoint = { provider: fallbackProvider, url: fallbackUrl, model: fallbackModel };
      if (process.env.RAG_FALLBACK_API_KEY) fb.apiKey = process.env.RAG_FALLBACK_API_KEY;
      endpoints.push(fb);
    }

    return endpoints;
  }

  private isValidProvider(value: unknown): value is EmbeddingProvider {
    return typeof value === 'string' && (EMBEDDING_PROVIDERS as readonly string[]).includes(value);
  }

  private decodeStored(raw: string): EmbeddingEndpoint[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(`Malformed ${SETTING_RAG_ENDPOINTS_V1} JSON — ignoring`);
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: EmbeddingEndpoint[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const { provider, url, model, apiKeyEnc } = entry as Partial<StoredEndpoint>;
      if (!this.isValidProvider(provider) || !url || !model) continue;
      const ep: EmbeddingEndpoint = { provider, url, model };
      if (apiKeyEnc) {
        try {
          ep.apiKey = this.encryption.decrypt(apiKeyEnc);
        } catch (err) {
          this.logger.error(
            `Failed to decrypt API key for ${provider} @ ${url}: ${errorMessage(err)}. ` +
              'Endpoint runs without a key — reconfigure via Settings UI.',
          );
        }
      }
      out.push(ep);
    }
    return out;
  }

  private endpointKey(e: { provider: string; url: string; model: string }): string {
    return `${e.provider}${e.url}${e.model}`;
  }

  /** Public-safe view of configured endpoints — never returns API keys. */
  async getEndpointsPublic(): Promise<EmbeddingEndpointPublic[]> {
    const endpoints = await this.loadEndpoints();
    return endpoints.map((e) => ({
      provider: e.provider,
      url: e.url,
      model: e.model,
      hasApiKey: typeof e.apiKey === 'string' && e.apiKey.length > 0,
    }));
  }

  /** Returns true if endpoints came from the Settings DB (i.e. UI-managed). */
  async isManagedViaSettings(): Promise<boolean> {
    return (await this.settings.get(SETTING_RAG_ENDPOINTS_V1)) != null;
  }

  /**
   * Persist endpoints. Each incoming endpoint's `apiKey`:
   * - undefined → keep existing key for matching provider+url+model
   * - "" → delete key
   * - non-empty string → encrypt and store
   * After persisting, the embedding pipeline is re-initialized so the new
   * config takes effect immediately. If the active model changes dimensions,
   * a reindex is required (the UI surfaces this warning).
   */
  async setEndpoints(incoming: EmbeddingEndpointInput[]): Promise<void> {
    if (incoming.length === 0) {
      throw new Error('At least one embedding endpoint is required');
    }
    for (const e of incoming) {
      if (!this.isValidProvider(e.provider)) throw new Error(`Invalid provider: ${e.provider}`);
      if (!e.url?.trim()) throw new Error('Endpoint url is required');
      if (!e.model?.trim()) throw new Error('Endpoint model is required');
    }

    const previous = await this.loadEndpoints();
    const byKey = new Map(previous.map((e) => [this.endpointKey(e), e.apiKey ?? '']));

    const stored: StoredEndpoint[] = incoming.map((e) => {
      let apiKey = e.apiKey;
      if (apiKey === undefined) {
        apiKey = byKey.get(this.endpointKey(e)) || undefined;
      } else if (apiKey === '') {
        apiKey = undefined;
      }
      const out: StoredEndpoint = { provider: e.provider, url: e.url, model: e.model };
      if (apiKey) {
        if (!this.encryption.isEnabled()) {
          throw new Error(
            'Cannot store API key: SECRETS_ENCRYPTION_KEY is not configured.',
          );
        }
        out.apiKeyEnc = this.encryption.encrypt(apiKey);
      }
      return out;
    });

    await this.settings.set(SETTING_RAG_ENDPOINTS_V1, JSON.stringify(stored));
    await this.reload();
  }

  /** Probe a single endpoint without persisting. Returns dimensions + latency. */
  async testEndpoint(endpoint: EmbeddingEndpointInput): Promise<EmbeddingEndpointTestResult> {
    if (!this.isValidProvider(endpoint.provider)) {
      return { ok: false, error: `Invalid provider: ${endpoint.provider}` };
    }
    if (!endpoint.url?.trim() || !endpoint.model?.trim()) {
      return { ok: false, error: 'url and model are required' };
    }
    // If the apiKey is undefined, fall back to the stored key for the same provider+url+model.
    let apiKey = endpoint.apiKey;
    if (apiKey === undefined) {
      const previous = await this.loadEndpoints();
      const match = previous.find((e) => this.endpointKey(e) === this.endpointKey(endpoint));
      if (match?.apiKey) apiKey = match.apiKey;
    } else if (apiKey === '') {
      apiKey = undefined;
    }
    const probe: EmbeddingEndpoint = { provider: endpoint.provider, url: endpoint.url, model: endpoint.model };
    if (apiKey) probe.apiKey = apiKey;
    const start = Date.now();
    try {
      const vec = await this.embedWithEndpoint(probe, 'health-check');
      return { ok: true, dimensions: vec.length, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, error: errorMessage(err), latencyMs: Date.now() - start };
    }
  }

  /**
   * Reload endpoints + re-init embedding session. Drops `ready` until a working
   * endpoint is found. Vector store table stays untouched — caller is responsible
   * for triggering reindex if dimensions or model semantics changed.
   */
  async reload(): Promise<void> {
    this.ready = false;
    this.initPromise = this.initialize().catch((err: unknown) => {
      this.logger.warn(`RAG re-initialization failed: ${errorMessage(err)}.`);
    });
    await this.initPromise;
  }

  private async initialize() {
    this.endpoints = await this.loadEndpoints();
    if (this.endpoints.length === 0) {
      throw new Error('No embedding endpoints configured (Settings UI or RAG_* env vars)');
    }

    // Try endpoints in order until one works
    let testEmbedding: number[] | null = null;
    let activeEndpoint: EmbeddingEndpoint | null = null;
    for (const endpoint of this.endpoints) {
      try {
        testEmbedding = await this.embedWithEndpoint(endpoint, 'test');
        activeEndpoint = endpoint;
        this.logger.log(`Embedding connected: provider=${endpoint.provider}, model=${endpoint.model}, url=${endpoint.url}`);
        break;
      } catch (err) {
        this.logger.warn(`Embedding endpoint unavailable: ${endpoint.provider} @ ${endpoint.url} — ${errorMessage(err)}`);
      }
    }

    if (!testEmbedding || !activeEndpoint) {
      throw new Error('No embedding endpoint available');
    }

    this.embeddingProvider = activeEndpoint.provider;
    this.embeddingUrl = activeEndpoint.url;
    this.embeddingModel = activeEndpoint.model;
    this.dimensions = testEmbedding.length;
    this.logger.log(`Embedding dimensions: ${this.dimensions}`);

    // Open LanceDB (file-based, stored next to data)
    const dbPath = process.env.RAG_DB_PATH || path.join(process.cwd(), 'data', 'lancedb');
    this.db = await lancedb.connect(dbPath);

    // Open or create table
    const tableNames = await this.db.tableNames();
    if (tableNames.includes('documents')) {
      this.table = await this.db.openTable('documents');
    } else {
      // Create with a dummy record (LanceDB requires at least one record to infer schema)
      const zeroVector = new Array(this.dimensions).fill(0);
      this.table = await this.db.createTable('documents', [
        {
          id: '__init__',
          sourceId: '__init__',
          chunkIndex: 0,
          projectId: '__init__',
          customerId: '',
          entity: '__init__',
          title: '__init__',
          content: '__init__',
          vector: zeroVector,
        },
      ]);
      // Remove the dummy record
      await this.table.delete('id = "__init__"');
    }

    this.ready = true;
    this.logger.log(`RAG ready. LanceDB at ${dbPath}`);
  }

  private async ensureReady(): Promise<boolean> {
    if (this.ready) return true;
    if (this.initPromise) {
      try {
        await this.initPromise;
        return this.ready;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** Low-level embedding call against an explicit endpoint (with optional API key). */
  private async embedWithEndpoint(endpoint: EmbeddingEndpoint, text: string): Promise<number[]> {
    const timeoutMs = parseInt(process.env.RAG_TIMEOUT_MS || '5000', 10);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (endpoint.apiKey) headers['Authorization'] = `Bearer ${endpoint.apiKey}`;

    if (endpoint.provider === 'openai-compatible') {
      const res = await fetch(`${endpoint.url}/v1/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: endpoint.model, input: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`Embedding API failed (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
      return data.data[0].embedding;
    } else {
      const res = await fetch(`${endpoint.url}/api/embed`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: endpoint.model, input: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as { embeddings: number[][] };
      return data.embeddings[0];
    }
  }

  private activeEndpoint(): EmbeddingEndpoint | null {
    return (
      this.endpoints.find(
        (e) =>
          e.provider === this.embeddingProvider &&
          e.url === this.embeddingUrl &&
          e.model === this.embeddingModel,
      ) || null
    );
  }

  /** Split text into overlapping chunks, preferring natural boundaries */
  private chunkText(text: string, maxChars?: number, overlap?: number): string[] {
    const chunkSize = maxChars ?? parseInt(
      process.env.RAG_CHUNK_SIZE || process.env.RAG_MAX_INPUT_CHARS || '1800', 10,
    );
    const chunkOverlap = overlap ?? parseInt(process.env.RAG_CHUNK_OVERLAP || '200', 10);

    if (text.length <= chunkSize) return [text];

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = Math.min(start + chunkSize, text.length);

      // If not at the end of text, find a natural break point
      if (end < text.length) {
        const window = text.slice(start, end);
        // Try paragraph break, then sentence, then word
        const paraBreak = window.lastIndexOf('\n\n');
        const sentenceBreak = window.lastIndexOf('. ');
        const wordBreak = window.lastIndexOf(' ');

        if (paraBreak > chunkSize * 0.5) {
          end = start + paraBreak + 2; // Include the \n\n
        } else if (sentenceBreak > chunkSize * 0.5) {
          end = start + sentenceBreak + 2; // Include the ". "
        } else if (wordBreak > chunkSize * 0.5) {
          end = start + wordBreak + 1; // Include the space
        }
      }

      chunks.push(text.slice(start, end));

      // Next chunk starts with overlap from the end of current chunk
      if (end >= text.length) break;
      const nextStart = end - Math.min(chunkOverlap, end - start - 1);
      // Prevent infinite loop: ensure we always advance at least 1 char
      if (nextStart <= start) break;
      start = nextStart;
    }

    return chunks;
  }

  /** Get embedding with logging, routed through the balancer queue */
  private async getEmbedding(text: string): Promise<number[]> {
    const preview = text.slice(0, 80).replace(/\n/g, ' ');
    this.logger.log(`Embedding: "${preview}${text.length > 80 ? '…' : ''}" (${text.length} chars)`);
    const start = Date.now();
    const vector = await this.gateway.runEmbed({ text });
    this.logger.log(`Embedded in ${Date.now() - start}ms (${vector.length} dims via balancer)`);
    return vector;
  }

  /**
   * Serialize a schema document into stable RAG text.
   *
   * `DbSchema.fields`/`indexes` are declared `[Object]` in Mongoose, i.e. the
   * DB accepts arbitrary shapes there. Every value therefore goes through
   * `asText`/`asTextList`, which drop non-text values instead of embedding
   * `[object Object]` into the index.
   */
  private serializeSchema(doc: Record<string, unknown>): string {
    const parts: string[] = [];
    const add = (label: string, value: unknown) => {
      const text = asText(value);
      if (text === '') return;
      parts.push(`${label}: ${text}`);
    };

    add('Schema name', doc.name);
    add('Database type', doc.dbType);
    add('Database', doc.database);
    add('Description', doc.description);
    const tags = asTextList(doc.tags);
    if (tags.length > 0) parts.push(`Tags: ${tags.join(', ')}`);

    const fields = isUnknownArray(doc.fields) ? doc.fields.filter(isRecord) : [];
    if (fields.length > 0) {
      parts.push('Fields:');
      for (const field of fields) {
        const attrs: string[] = [];
        const type = asText(field.type);
        if (type !== '') attrs.push(`type=${type}`);
        if (typeof field.nullable === 'boolean') attrs.push(`nullable=${asText(field.nullable)}`);
        const defaultValue = asText(field.defaultValue);
        if (defaultValue !== '') attrs.push(`default=${defaultValue}`);
        if (field.isPrimaryKey) attrs.push('primaryKey');
        if (field.isIndexed) attrs.push('indexed');
        const reference = asText(field.reference);
        if (reference !== '') attrs.push(`reference=${reference}`);
        const suffix = attrs.length > 0 ? ` (${attrs.join(', ')})` : '';
        const description = asText(field.description);
        const descriptionSuffix = description !== '' ? ` — ${description}` : '';
        parts.push(`- ${asText(field.name) || 'unnamed'}${suffix}${descriptionSuffix}`);
      }
    }

    const indexes = isUnknownArray(doc.indexes) ? doc.indexes.filter(isRecord) : [];
    if (indexes.length > 0) {
      parts.push('Indexes:');
      for (const index of indexes) {
        const attrs: string[] = [];
        const indexFields = asTextList(index.fields);
        if (indexFields.length > 0) attrs.push(`fields=${indexFields.join(',')}`);
        if (index.unique) attrs.push('unique');
        const type = asText(index.type);
        if (type !== '') attrs.push(`type=${type}`);
        const suffix = attrs.length > 0 ? ` (${attrs.join(', ')})` : '';
        parts.push(`- ${asText(index.name) || 'unnamed'}${suffix}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Extract indexable text from a MongoDB document.
   *
   * Field values arrive untyped (`Record<string, unknown>` straight from the
   * driver), so every read goes through `asText`/`asTextList`. Field *names*
   * must match the Mongoose schema of the respective collection — a typo here
   * fails silently and produces content-free index entries (see 'changelog').
   */
  private extractText(entity: IndexableEntity, doc: Record<string, unknown>): { title: string; content: string } | null {
    switch (entity) {
      case 'knowledge':
        return { title: asText(doc.topic), content: asText(doc.content) };
      case 'research':
        return { title: asText(doc.title), content: asText(doc.content) };
      case 'manual':
        return { title: asText(doc.title), content: asText(doc.content) };
      case 'changelog': {
        // Field names per changelog.schema.ts: version/summary/component/
        // repoLabel/changes[]. The previous implementation read type/title/
        // description — fields that never existed on this collection, so every
        // changelog was indexed as the literal string ": " (541 useless
        // entries) and changelog text was not searchable at all.
        const version = asText(doc.version);
        const summary = asText(doc.summary);
        const component = asText(doc.component);
        const repoLabel = asText(doc.repoLabel);
        const changes = asTextList(doc.changes);
        const contentParts: string[] = [];
        if (component !== '') contentParts.push(`Component: ${component}`);
        if (repoLabel !== '') contentParts.push(`Repository: ${repoLabel}`);
        if (changes.length > 0) contentParts.push(changes.map((change) => `- ${change}`).join('\n'));
        return {
          title: [version, summary].filter((part) => part !== '').join(' — '),
          content: contentParts.join('\n'),
        };
      }
      case 'todo':
        return { title: asText(doc.title), content: asText(doc.description) };
      case 'session':
        return { title: 'Session', content: asText(doc.summary) };
      case 'snippet': {
        const language = asText(doc.language);
        const code = asText(doc.code);
        return {
          title: asText(doc.title),
          content: language !== '' ? `[${language}] ${code}` : code,
        };
      }
      case 'attachment':
        return { title: asText(doc.originalName), content: asText(doc.textContent) };
      case 'schema':
        return { title: asText(doc.name), content: this.serializeSchema(doc) };
      case 'project': {
        const parts: string[] = [];
        const description = asText(doc.description);
        if (description !== '') parts.push(description);
        const techStack = asTextList(doc.techStack);
        if (techStack.length > 0) parts.push(`Tech: ${techStack.join(', ')}`);
        const tags = asTextList(doc.tags);
        if (tags.length > 0) parts.push(`Tags: ${tags.join(', ')}`);
        const instructions = asText(doc.instructions);
        if (instructions !== '') parts.push(instructions);
        return { title: asText(doc.name), content: parts.join('\n') };
      }
      case 'question': {
        // T-392: only answered questions belong in the index — pending ones
        // would pollute results with unresolved noise and create privacy
        // issues for user-targeted asks.
        if (asText(doc.status) !== 'answered') return null;
        const titlePrefix = asText(doc.direction) === 'user_to_agent' ? 'Q→Agent: ' : 'Q→User: ';
        const question = asText(doc.question);
        const parts: string[] = [`Frage: ${question}`];
        const context = asText(doc.context);
        if (context !== '') parts.push(`Kontext: ${context}`);
        const answer = asText(doc.answer);
        if (answer !== '') parts.push(`Antwort: ${answer}`);
        return {
          title: titlePrefix + question.slice(0, 120),
          content: parts.join('\n\n'),
        };
      }
      case 'research_artifact': {
        const summary = asText(doc.summary);
        return { title: asText(doc.title), content: summary !== '' ? summary : asText(doc.content) };
      }
      default:
        return null;
    }
  }

  /** Upsert a single document into the vector store (with chunking) */
  private async upsertDocument(entity: IndexableEntity, doc: Record<string, unknown>): Promise<void> {
    if (!this.table) return;

    // T-219: respect data classification. confidential/personal/secret entries
    // never enter the index. We also remove any pre-existing chunks for this
    // doc so a `internal → confidential` reclassification effectively redacts
    // it from RAG.
    const sensitivity: SensitivityLevel | undefined = isSensitivityLevel(doc.sensitivity)
      ? doc.sensitivity
      : undefined;
    const docId = asText(doc._id);
    if (docId === '') {
      this.logger.warn(`Skipping ${entity} document without usable _id`);
      return;
    }
    if (isExcludedFromRag(sensitivity)) {
      await this.removeDocument(docId);
      return;
    }

    const extracted = this.extractText(entity, doc);
    if (!extracted || (!extracted.title && !extracted.content)) return;

    // For project entities the doc IS the project, so its _id is the projectId.
    const projectId = entity === 'project' ? docId : asText(doc.projectId);
    const customerId = asText(doc.customerId);
    const combinedText = `${extracted.title}\n${extracted.content}`.trim();

    // Delete all existing chunks for this document
    try {
      await this.table.delete(`id = "${docId}" OR id LIKE "${docId}__chunk_%"`);
    } catch {
      // Records might not exist yet
    }

    const chunks = this.chunkText(combinedText);
    const records: RagDocument[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const vector = await this.getEmbedding(chunks[i]);
      const id = chunks.length === 1 ? docId : `${docId}__chunk_${i}`;
      records.push({
        id,
        sourceId: docId,
        chunkIndex: i,
        projectId,
        customerId,
        entity,
        title: extracted.title,
        content: chunks[i].slice(0, 2000),
        vector,
      });
    }

    if (records.length > 0) {
      await this.table.add(records);
    }
  }

  /** Remove a document (and all its chunks) from the vector store */
  private async removeDocument(entityId: string): Promise<void> {
    if (!this.table) return;
    try {
      await this.table.delete(`id = "${entityId}" OR id LIKE "${entityId}__chunk_%"`);
    } catch {
      // Ignore if not found
    }
  }

  /** React to Change Stream / EventEmitter events for incremental sync */
  @OnEvent(PROJECT_CHANGED)
  async handleProjectChange(event: ProjectChangeEvent): Promise<void> {
    // Skip in stdio MCP mode — only the HTTP backend should do background indexing
    if (process.env.MCP_STDIO === 'true') return;
    if (!(await this.ensureReady())) return;
    if (!isIndexableEntity(event.entity)) return;
    if (!event.entityId) return;

    const entity = event.entity;

    if (event.action === 'deleted') {
      await this.removeDocument(event.entityId).catch((err: unknown) =>
        this.logger.warn(`RAG delete failed: ${errorMessage(err)}`),
      );
      return;
    }

    // For created/updated: fetch the document from MongoDB and upsert
    try {
      const collection = ENTITY_COLLECTION_MAP[entity];
      const db = this.connection.db;
      if (!db) return;

      const { ObjectId } = await import('mongodb');
      const doc = await db.collection(collection).findOne({ _id: new ObjectId(event.entityId) });
      if (doc) {
        await this.upsertDocument(entity, doc);
      }
    } catch (err) {
      this.logger.warn(`RAG upsert failed for ${entity}/${event.entityId}: ${errorMessage(err)}`);
    }
  }

  /**
   * Boundary for every LanceDB read: the driver declares `toArray()` as
   * `any[]`, which would spread untyped values through the whole service. Rows
   * leave this method as `LanceRow`, so all column reads have to be narrowed
   * explicitly (`asText`/`asNumber`).
   */
  private async queryRows(query: { toArray(): Promise<unknown[]> }): Promise<LanceRow[]> {
    const rows = await query.toArray();
    return rows.filter(isRecord);
  }

  /**
   * Semantic search across all indexed documents (deduplicated by source document).
   *
   * The return type is structurally identical to `RagSearchHit[]` but stays
   * spelled out inline on purpose: mcp-tools.ts assigns the result to
   * `Array<Record<string, unknown>>`, which TypeScript only permits for
   * anonymous object types (those get an implicit index signature, named
   * interfaces don't).
   */
  async search(
    query: string,
    projectId?: string,
    entity?: string,
    limit = 10,
    customerId?: string,
  ): Promise<Array<{ id: string; projectId: string; customerId: string; entity: string; title: string; content: string; score: number }>> {
    if (!(await this.ensureReady())) {
      throw new Error('RAG not available. Is the embedding server running?');
    }

    const vector = await this.getEmbedding(query);

    // Overfetch for filtering + dedup
    const results = await this.queryRows(this.table!.search(vector).limit(limit * 5));

    // Apply caller's scope (api-key/user) on top of explicit filter args. We
    // filter post-hoc on the JS side because LanceDB filter expressions are
    // limited; the cost is ~5x overfetch which is already in place above.
    // Admin role intentionally does NOT bypass scope here — an admin's
    // narrow-scope api-key must hold (see common/permissions.ts).
    const actor = RequestContext.getUser();
    const enforceProjectScope = !!actor && !!actor.projectScopeMode && actor.projectScopeMode !== 'all';
    const enforceCustomerScope = !!actor && !!actor.customerScopeMode && actor.customerScopeMode !== 'all';
    const allowedProjectIds = new Set((actor?.allowedProjectIds || []).map(String));
    const allowedCustomerIds = new Set((actor?.allowedCustomerIds || []).map(String));

    // Filter, deduplicate by sourceId (keep best chunk per document), then limit
    const seen = new Map<string, RagSearchHit>();
    for (const row of results) {
      const rowId = asText(row.id);
      if (rowId === '__init__') continue;

      // A row's projectId/customerId is the empty string for global entries —
      // those always pass, both for the explicit filter args and for the
      // server-side scope enforcement below.
      const rowProjectId = asText(row.projectId);
      const rowCustomerId = asText(row.customerId);
      const rowEntity = asText(row.entity);

      if (projectId && rowProjectId !== projectId && rowProjectId !== '') continue;
      if (customerId && rowCustomerId !== customerId && rowCustomerId !== '') continue;
      if (entity && rowEntity !== entity) continue;

      if (enforceProjectScope && rowProjectId && !allowedProjectIds.has(rowProjectId)) {
        if (actor.projectScopeMode === 'none') continue;
        continue;
      }
      if (enforceCustomerScope && rowCustomerId && !allowedCustomerIds.has(rowCustomerId)) {
        if (actor.customerScopeMode === 'none') continue;
        continue;
      }

      const sourceId = asText(row.sourceId) || rowId;
      const distance = asNumber(row._distance);
      const score = distance !== undefined ? 1 - distance : 0;

      const existing = seen.get(sourceId);
      if (!existing || score > existing.score) {
        seen.set(sourceId, {
          id: sourceId,
          projectId: rowProjectId,
          customerId: rowCustomerId,
          entity: rowEntity,
          title: asText(row.title),
          content: asText(row.content),
          score,
        });
      }
    }

    return Array.from(seen.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Multi-scope semantic search: runs the existing scoped `search()` once per
   * projectId, once per customerId, and (if requested) once unscoped for
   * global reach, then merges everything through `mergeScopeHits`. Each
   * per-scope call still goes through `search()`'s own post-hoc scope
   * enforcement (the caller's api-key/user scope), so this cannot widen
   * access beyond what a single `search()` call already allows.
   */
  async searchScopes(
    query: string,
    scope: { projectIds: string[]; customerIds: string[]; includeGlobal: boolean },
    limit?: number,
  ): Promise<RagSearchHit[]> {
    const effectiveLimit = limit ?? 8;

    const searches: Promise<RagSearchHit[]>[] = [];
    for (const projectId of scope.projectIds) {
      searches.push(this.search(query, projectId, undefined, effectiveLimit));
    }
    for (const customerId of scope.customerIds) {
      searches.push(this.search(query, undefined, undefined, effectiveLimit, customerId));
    }
    if (scope.includeGlobal) {
      searches.push(this.search(query, undefined, undefined, effectiveLimit));
    }

    if (searches.length === 0) return [];

    const hitLists = await Promise.all(searches);
    return mergeScopeHits(hitLists, effectiveLimit);
  }

  /** Full reindex of all indexable entities (optionally scoped to a project or customer) */
  async reindex(projectId?: string, customerId?: string): Promise<{ indexed: number; entities: Record<string, number> }> {
    if (!(await this.ensureReady())) {
      throw new Error('RAG not available. Is the embedding server running?');
    }

    const db = this.connection.db;
    if (!db) throw new Error('MongoDB not available');

    // Clear existing data for the scope
    if (projectId) {
      await this.table!.delete(`projectId = "${projectId}"`);
    } else if (customerId) {
      await this.table!.delete(`customerId = "${customerId}"`);
    } else {
      // Full reindex: drop and recreate table
      await this.db!.dropTable('documents');
      const zeroVector = new Array(this.dimensions).fill(0);
      this.table = await this.db!.createTable('documents', [
        { id: '__init__', sourceId: '__init__', chunkIndex: 0, projectId: '__init__', customerId: '', entity: '__init__', title: '__init__', content: '__init__', vector: zeroVector },
      ]);
      await this.table.delete('id = "__init__"');
    }

    let totalIndexed = 0;
    const entityCounts: Record<string, number> = {};

    for (const entity of INDEXABLE_ENTITIES) {
      this.logger.log(`Reindexing ${entity}...`);
      const collection = ENTITY_COLLECTION_MAP[entity];
      const filter: Record<string, unknown> = {};
      const { ObjectId } = await import('mongodb');
      if (projectId) {
        if (entity === 'project') {
          // Project docs identify by _id, not by projectId field.
          filter._id = new ObjectId(projectId);
        } else {
          // Include project-specific + global entries (no projectId)
          filter.$or = [
            { projectId: new ObjectId(projectId) },
            { projectId: { $exists: false } },
            { projectId: null },
          ];
        }
      } else if (customerId) {
        if (entity === 'project') {
          // Skip projects in customer-scoped reindex (project↔customer is via
          // customer_project_links, not a customerId field on Project).
          continue;
        }
        filter.customerId = new ObjectId(customerId);
      }

      const cursor = db.collection(collection).find(filter);
      let count = 0;

      // Process in batches (with chunking)
      const batch: RagDocument[] = [];
      for await (const doc of cursor) {
        // T-219: honour the data classification here as well. `upsertDocument`
        // keeps confidential/personal/secret entries out of the index, so a
        // full reindex must not quietly put them back in.
        const sensitivity = isSensitivityLevel(doc.sensitivity) ? doc.sensitivity : undefined;
        if (isExcludedFromRag(sensitivity)) continue;

        const extracted = this.extractText(entity, doc);
        if (!extracted || (!extracted.title && !extracted.content)) continue;

        const docId = asText(doc._id);
        if (docId === '') {
          this.logger.warn(`Skipping ${entity} document without usable _id`);
          continue;
        }
        const docProjectId = entity === 'project' ? docId : asText(doc.projectId);
        const docCustomerId = asText(doc.customerId);
        const combinedText = `${extracted.title}\n${extracted.content}`.trim();
        const chunks = this.chunkText(combinedText);

        for (let i = 0; i < chunks.length; i++) {
          const vector = await this.getEmbedding(chunks[i]);
          const id = chunks.length === 1 ? docId : `${docId}__chunk_${i}`;
          batch.push({
            id,
            sourceId: docId,
            chunkIndex: i,
            projectId: docProjectId,
            customerId: docCustomerId,
            entity,
            title: extracted.title,
            content: chunks[i].slice(0, 2000),
            vector,
          });
        }
        count++;

        // Flush batch every 50 records
        if (batch.length >= 50) {
          await this.table!.add(batch);
          batch.length = 0;
        }
      }

      // Flush remaining
      if (batch.length > 0) {
        await this.table!.add(batch);
      }

      entityCounts[entity] = count;
      totalIndexed += count;
      this.logger.log(`Reindexed ${entity}: ${count} documents`);
    }

    this.logger.log(`Reindex complete: ${totalIndexed} documents indexed`);
    return { indexed: totalIndexed, entities: entityCounts };
  }

  /** Get index statistics */
  async status(): Promise<{
    ready: boolean;
    activeEndpoint: { provider: string; model: string; url: string };
    endpoints: EmbeddingEndpoint[];
    dimensions: number;
    documentCount: number;
    chunkCount: number;
    entities: Record<string, number>;
  }> {
    const isReady = await this.ensureReady();

    if (!isReady || !this.table) {
      return {
        ready: false,
        activeEndpoint: { provider: this.embeddingProvider, model: this.embeddingModel, url: this.embeddingUrl },
        endpoints: this.endpoints,
        dimensions: 0,
        documentCount: 0,
        chunkCount: 0,
        entities: {},
      };
    }

    const zeroVector = new Array<number>(this.dimensions).fill(0);
    const allRows = await this.queryRows(this.table.search(zeroVector).limit(100000));
    const validRows = allRows.filter((row) => asText(row.id) !== '__init__');

    // Count unique source documents and entities (by sourceId)
    const uniqueSources = new Set<string>();
    const entities: Record<string, number> = {};
    for (const row of validRows) {
      const sourceId = asText(row.sourceId) || asText(row.id);
      if (!uniqueSources.has(sourceId)) {
        uniqueSources.add(sourceId);
        const e = asText(row.entity);
        entities[e] = (entities[e] || 0) + 1;
      }
    }

    return {
      ready: true,
      activeEndpoint: { provider: this.embeddingProvider, model: this.embeddingModel, url: this.embeddingUrl },
      endpoints: this.endpoints,
      dimensions: this.dimensions,
      documentCount: uniqueSources.size,
      chunkCount: validRows.length,
      entities,
    };
  }
}
