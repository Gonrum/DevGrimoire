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
import { isExcludedFromRag, SensitivityLevel } from '../common/sensitivity';

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

export interface EmbeddingEndpointInput {
  provider: EmbeddingProvider;
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
  ) {}

  async onModuleInit() {
    this.initPromise = this.initialize();
    // Don't await — let the app start even if embedding server is not available
    this.initPromise.catch((err) => {
      this.logger.warn(`RAG initialization failed: ${err.message}. RAG features disabled.`);
    });
  }

  async onModuleDestroy() {
    this.db = null;
    this.table = null;
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
            `Failed to decrypt API key for ${provider} @ ${url}: ${(err as Error).message}. ` +
              'Endpoint runs without a key — reconfigure via Settings UI.',
          );
        }
      }
      out.push(ep);
    }
    return out;
  }

  private endpointKey(e: Pick<EmbeddingEndpoint, 'provider' | 'url' | 'model'>): string {
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
      return { ok: false, error: (err as Error).message, latencyMs: Date.now() - start };
    }
  }

  /**
   * Reload endpoints + re-init embedding session. Drops `ready` until a working
   * endpoint is found. Vector store table stays untouched — caller is responsible
   * for triggering reindex if dimensions or model semantics changed.
   */
  async reload(): Promise<void> {
    this.ready = false;
    this.initPromise = this.initialize().catch((err) => {
      this.logger.warn(`RAG re-initialization failed: ${err.message}.`);
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
        this.logger.warn(`Embedding endpoint unavailable: ${endpoint.provider} @ ${endpoint.url} — ${(err as Error).message}`);
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

  /** Get embedding with logging and automatic fallback */
  private async getEmbedding(text: string): Promise<number[]> {
    const preview = text.slice(0, 80).replace(/\n/g, ' ');
    this.logger.log(`Embedding: "${preview}${text.length > 80 ? '…' : ''}" (${text.length} chars)`);
    const start = Date.now();

    const active = this.activeEndpoint() ?? this.endpoints[0];
    try {
      const vector = await this.embedWithEndpoint(active, text);
      this.logger.log(`Embedded in ${Date.now() - start}ms (${vector.length} dims, ${active.provider})`);
      return vector;
    } catch (err) {
      // Try fallback to next endpoint
      const currentIdx = this.endpoints.indexOf(active);
      for (let i = 0; i < this.endpoints.length; i++) {
        if (i === currentIdx) continue;
        const fallback = this.endpoints[i];
        try {
          this.logger.warn(`Primary embedding failed, trying fallback: ${fallback.provider} @ ${fallback.url}`);
          const vector = await this.embedWithEndpoint(fallback, text);
          this.embeddingProvider = fallback.provider;
          this.embeddingUrl = fallback.url;
          this.embeddingModel = fallback.model;
          this.logger.log(`Fallback succeeded: ${fallback.provider} in ${Date.now() - start}ms`);
          return vector;
        } catch {
          this.logger.warn(`Fallback ${fallback.provider} also failed`);
        }
      }
      throw err; // All endpoints failed
    }
  }

  /** Serialize a schema document into stable RAG text. */
  private serializeSchema(doc: Record<string, unknown>): string {
    const parts: string[] = [];
    const add = (label: string, value: unknown) => {
      if (value === undefined || value === null || value === '') return;
      parts.push(`${label}: ${String(value)}`);
    };

    add('Schema name', doc.name);
    add('Database type', doc.dbType);
    add('Database', doc.database);
    add('Description', doc.description);
    if (Array.isArray(doc.tags) && doc.tags.length > 0) {
      parts.push(`Tags: ${doc.tags.map(String).join(', ')}`);
    }

    if (Array.isArray(doc.fields) && doc.fields.length > 0) {
      parts.push('Fields:');
      for (const field of doc.fields as Array<Record<string, unknown>>) {
        const attrs: string[] = [];
        if (field.type) attrs.push(`type=${field.type}`);
        if (field.nullable !== undefined) attrs.push(`nullable=${field.nullable}`);
        if (field.defaultValue !== undefined && field.defaultValue !== '') attrs.push(`default=${field.defaultValue}`);
        if (field.isPrimaryKey) attrs.push('primaryKey');
        if (field.isIndexed) attrs.push('indexed');
        if (field.reference) attrs.push(`reference=${field.reference}`);
        const suffix = attrs.length > 0 ? ` (${attrs.join(', ')})` : '';
        const description = field.description ? ` — ${field.description}` : '';
        parts.push(`- ${String(field.name || 'unnamed')}${suffix}${description}`);
      }
    }

    if (Array.isArray(doc.indexes) && doc.indexes.length > 0) {
      parts.push('Indexes:');
      for (const index of doc.indexes as Array<Record<string, unknown>>) {
        const attrs: string[] = [];
        if (Array.isArray(index.fields) && index.fields.length > 0) attrs.push(`fields=${index.fields.map(String).join(',')}`);
        if (index.unique) attrs.push('unique');
        if (index.type) attrs.push(`type=${index.type}`);
        const suffix = attrs.length > 0 ? ` (${attrs.join(', ')})` : '';
        parts.push(`- ${String(index.name || 'unnamed')}${suffix}`);
      }
    }

    return parts.join('\n');
  }

  /** Extract indexable text from a MongoDB document */
  private extractText(entity: IndexableEntity, doc: Record<string, unknown>): { title: string; content: string } | null {
    switch (entity) {
      case 'knowledge':
        return { title: String(doc.topic || ''), content: String(doc.content || '') };
      case 'research':
        return { title: String(doc.title || ''), content: String(doc.content || '') };
      case 'manual':
        return { title: String(doc.title || ''), content: String(doc.content || '') };
      case 'changelog':
        return { title: String(doc.type || '') + ': ' + String(doc.title || ''), content: String(doc.description || '') };
      case 'todo':
        return { title: String(doc.title || ''), content: String(doc.description || '') };
      case 'session':
        return { title: 'Session', content: String(doc.summary || '') };
      case 'snippet':
        return { title: String(doc.title || ''), content: `[${String(doc.language || '')}] ${String(doc.code || '')}` };
      case 'attachment':
        return { title: String(doc.originalName || ''), content: String(doc.textContent || '') };
      case 'schema':
        return { title: String(doc.name || ''), content: this.serializeSchema(doc) };
      case 'project': {
        const parts: string[] = [];
        if (doc.description) parts.push(String(doc.description));
        if (Array.isArray(doc.techStack) && doc.techStack.length > 0) {
          parts.push(`Tech: ${(doc.techStack as unknown[]).map(String).join(', ')}`);
        }
        if (Array.isArray(doc.tags) && doc.tags.length > 0) {
          parts.push(`Tags: ${(doc.tags as unknown[]).map(String).join(', ')}`);
        }
        if (doc.instructions) parts.push(String(doc.instructions));
        return { title: String(doc.name || ''), content: parts.join('\n') };
      }
      case 'question': {
        // T-392: only answered questions belong in the index — pending ones
        // would pollute results with unresolved noise and create privacy
        // issues for user-targeted asks.
        if (doc.status !== 'answered') return null;
        const titlePrefix = doc.direction === 'user_to_agent' ? 'Q→Agent: ' : 'Q→User: ';
        const parts: string[] = [];
        parts.push(`Frage: ${String(doc.question || '')}`);
        if (doc.context) parts.push(`Kontext: ${String(doc.context)}`);
        if (doc.answer) parts.push(`Antwort: ${String(doc.answer)}`);
        return {
          title: titlePrefix + String(doc.question || '').slice(0, 120),
          content: parts.join('\n\n'),
        };
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
    const sensitivity = doc.sensitivity as SensitivityLevel | undefined;
    if (isExcludedFromRag(sensitivity)) {
      await this.removeDocument(String(doc._id));
      return;
    }

    const extracted = this.extractText(entity, doc);
    if (!extracted || (!extracted.title && !extracted.content)) return;

    const docId = String(doc._id);
    // For project entities the doc IS the project, so its _id is the projectId.
    const projectId = entity === 'project' ? docId : String(doc.projectId || '');
    const customerId = String(doc.customerId || '');
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
    if (!INDEXABLE_ENTITIES.includes(event.entity as IndexableEntity)) return;
    if (!event.entityId) return;

    const entity = event.entity as IndexableEntity;

    if (event.action === 'deleted') {
      await this.removeDocument(event.entityId).catch((err) =>
        this.logger.warn(`RAG delete failed: ${err.message}`),
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
        await this.upsertDocument(entity, doc as Record<string, unknown>);
      }
    } catch (err) {
      this.logger.warn(`RAG upsert failed for ${entity}/${event.entityId}: ${(err as Error).message}`);
    }
  }

  /** Semantic search across all indexed documents (deduplicated by source document) */
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

    const queryBuilder = this.table!.search(vector).limit(limit * 5); // Overfetch for filtering + dedup

    const results = await queryBuilder.toArray();

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
    const seen = new Map<string, { row: Record<string, unknown>; score: number }>();
    for (const row of results) {
      if (row.id === '__init__') continue;
      if (projectId && row.projectId !== projectId && row.projectId !== '') continue;
      if (customerId && row.customerId !== customerId && row.customerId !== '') continue;
      if (entity && row.entity !== entity) continue;

      // Server-side scope enforcement. A row's projectId/customerId may be
      // empty string for global entries — those always pass.
      const rowProjectId = (row.projectId as string) || '';
      const rowCustomerId = (row.customerId as string) || '';
      if (enforceProjectScope && rowProjectId && !allowedProjectIds.has(rowProjectId)) {
        if (actor!.projectScopeMode === 'none') continue;
        continue;
      }
      if (enforceCustomerScope && rowCustomerId && !allowedCustomerIds.has(rowCustomerId)) {
        if (actor!.customerScopeMode === 'none') continue;
        continue;
      }

      const sourceId = (row.sourceId as string) || (row.id as string);
      const score = row._distance != null ? 1 - (row._distance as number) : 0;

      const existing = seen.get(sourceId);
      if (!existing || score > existing.score) {
        seen.set(sourceId, { row, score });
      }
    }

    return Array.from(seen.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row, score }) => ({
        id: ((row.sourceId as string) || (row.id as string)),
        projectId: row.projectId as string,
        customerId: (row.customerId as string) || '',
        entity: row.entity as string,
        title: row.title as string,
        content: row.content as string,
        score,
      }));
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
        const extracted = this.extractText(entity, doc as Record<string, unknown>);
        if (!extracted || (!extracted.title && !extracted.content)) continue;

        const docId = String(doc._id);
        const docProjectId = entity === 'project' ? docId : String(doc.projectId || '');
        const docCustomerId = String(doc.customerId || '');
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

    const allRows = await this.table.search(new Array(this.dimensions).fill(0)).limit(100000).toArray();
    const validRows = allRows.filter((r) => r.id !== '__init__');

    // Count unique source documents and entities (by sourceId)
    const uniqueSources = new Set<string>();
    const entities: Record<string, number> = {};
    for (const row of validRows) {
      const sourceId = (row.sourceId as string) || (row.id as string);
      if (!uniqueSources.has(sourceId)) {
        uniqueSources.add(sourceId);
        const e = row.entity as string;
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
