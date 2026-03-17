import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import * as lancedb from '@lancedb/lancedb';
import * as path from 'path';
import { PROJECT_CHANGED, ProjectChangeEvent } from '../events/project-event';

/** Entity types that contain indexable text content */
const INDEXABLE_ENTITIES = [
  'knowledge',
  'research',
  'manual',
  'changelog',
  'todo',
  'session',
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
};

interface RagDocument {
  [key: string]: unknown;
  id: string;
  projectId: string;
  entity: string;
  title: string;
  content: string;
  vector: number[];
}

type EmbeddingProvider = 'ollama' | 'openai-compatible';

interface EmbeddingEndpoint {
  provider: EmbeddingProvider;
  url: string;
  model: string;
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

  constructor(@InjectConnection() private readonly connection: Connection) {}

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
   * Build embedding endpoints from env vars.
   *
   * Config format (env):
   *   RAG_ENDPOINTS=openai-compatible|http://192.168.2.229:1234|text-embedding-nomic-embed-text-v2-moe,ollama|http://localhost:11434|nomic-embed-text-v2-moe
   *
   * Or use individual vars (single provider, no fallback):
   *   RAG_EMBEDDING_PROVIDER=ollama
   *   RAG_EMBEDDING_URL=http://localhost:11434
   *   RAG_EMBEDDING_MODEL=nomic-embed-text-v2-moe
   *
   * Defaults: LM Studio (GPU) primary, Ollama (CPU) fallback
   */
  private buildEndpoints(): EmbeddingEndpoint[] {
    const endpointsStr = process.env.RAG_ENDPOINTS;
    if (endpointsStr) {
      return endpointsStr.split(',').map((entry) => {
        const [provider, url, model] = entry.trim().split('|');
        return { provider: provider as EmbeddingProvider, url, model };
      });
    }

    // Single provider mode (backwards compatible)
    const provider = (process.env.RAG_EMBEDDING_PROVIDER || 'ollama') as EmbeddingProvider;
    const model = process.env.RAG_EMBEDDING_MODEL || 'nomic-embed-text';
    const url = provider === 'openai-compatible'
      ? (process.env.RAG_EMBEDDING_URL || 'http://localhost:1234')
      : (process.env.OLLAMA_URL || 'http://localhost:11434');

    const primary: EmbeddingEndpoint = { provider, url, model };
    const endpoints = [primary];

    // Auto-add fallback if configured via RAG_FALLBACK_* vars
    const fallbackProvider = process.env.RAG_FALLBACK_PROVIDER as EmbeddingProvider | undefined;
    const fallbackUrl = process.env.RAG_FALLBACK_URL;
    const fallbackModel = process.env.RAG_FALLBACK_MODEL;
    if (fallbackProvider && fallbackUrl && fallbackModel) {
      endpoints.push({ provider: fallbackProvider, url: fallbackUrl, model: fallbackModel });
    }

    return endpoints;
  }

  private async initialize() {
    this.endpoints = this.buildEndpoints();

    // Try endpoints in order until one works
    let testEmbedding: number[] | null = null;
    for (const endpoint of this.endpoints) {
      try {
        this.embeddingProvider = endpoint.provider;
        this.embeddingUrl = endpoint.url;
        this.embeddingModel = endpoint.model;
        testEmbedding = await this.callEmbeddingApi('test');
        this.logger.log(`Embedding connected: provider=${endpoint.provider}, model=${endpoint.model}, url=${endpoint.url}`);
        break;
      } catch (err) {
        this.logger.warn(`Embedding endpoint unavailable: ${endpoint.provider} @ ${endpoint.url} — ${(err as Error).message}`);
      }
    }

    if (!testEmbedding) {
      throw new Error('No embedding endpoint available (tried LM Studio + Ollama)');
    }

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
          projectId: '__init__',
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

  /** Low-level embedding call for a specific provider */
  private async callEmbeddingApi(text: string): Promise<number[]> {
    const timeoutMs = parseInt(process.env.RAG_TIMEOUT_MS || '5000', 10);
    if (this.embeddingProvider === 'openai-compatible') {
      const res = await fetch(`${this.embeddingUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.embeddingModel, input: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`Embedding API failed (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
      return data.data[0].embedding;
    } else {
      const res = await fetch(`${this.embeddingUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.embeddingModel, input: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as { embeddings: number[][] };
      return data.embeddings[0];
    }
  }

  /** Get embedding with truncation, logging, and automatic fallback */
  private async getEmbedding(text: string): Promise<number[]> {
    const maxChars = parseInt(process.env.RAG_MAX_INPUT_CHARS || '1800', 10);
    const truncated = text.length > maxChars ? text.slice(0, maxChars) : text;
    const preview = truncated.slice(0, 80).replace(/\n/g, ' ');
    this.logger.log(`Embedding: "${preview}${truncated.length > 80 ? '…' : ''}" (${truncated.length} chars)`);
    const start = Date.now();

    try {
      const vector = await this.callEmbeddingApi(truncated);
      this.logger.log(`Embedded in ${Date.now() - start}ms (${vector.length} dims, ${this.embeddingProvider})`);
      return vector;
    } catch (err) {
      // Try fallback to next endpoint
      const currentIdx = this.endpoints.findIndex(
        (e) => e.provider === this.embeddingProvider && e.url === this.embeddingUrl,
      );
      for (let i = 0; i < this.endpoints.length; i++) {
        if (i === currentIdx) continue;
        const fallback = this.endpoints[i];
        try {
          this.logger.warn(`Primary embedding failed, trying fallback: ${fallback.provider} @ ${fallback.url}`);
          const prevProvider = this.embeddingProvider;
          const prevUrl = this.embeddingUrl;
          const prevModel = this.embeddingModel;
          this.embeddingProvider = fallback.provider;
          this.embeddingUrl = fallback.url;
          this.embeddingModel = fallback.model;
          const vector = await this.callEmbeddingApi(truncated);
          this.logger.log(`Fallback succeeded: ${fallback.provider} in ${Date.now() - start}ms`);
          return vector;
        } catch {
          // Restore original and continue trying
          this.logger.warn(`Fallback ${fallback.provider} also failed`);
        }
      }
      throw err; // All endpoints failed
    }
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
      default:
        return null;
    }
  }

  /** Upsert a single document into the vector store */
  private async upsertDocument(entity: IndexableEntity, doc: Record<string, unknown>): Promise<void> {
    if (!this.table) return;

    const extracted = this.extractText(entity, doc);
    if (!extracted || (!extracted.title && !extracted.content)) return;

    const id = String(doc._id);
    const projectId = String(doc.projectId || '');
    const combinedText = `${extracted.title}\n${extracted.content}`.trim();

    const vector = await this.getEmbedding(combinedText);

    // Delete existing record if present, then add new one
    try {
      await this.table.delete(`id = "${id}"`);
    } catch {
      // Record might not exist yet
    }

    await this.table.add([{
      id,
      projectId,
      entity,
      title: extracted.title,
      content: extracted.content.slice(0, 2000), // Store truncated for display
      vector,
    }]);
  }

  /** Remove a document from the vector store */
  private async removeDocument(entityId: string): Promise<void> {
    if (!this.table) return;
    try {
      await this.table.delete(`id = "${entityId}"`);
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

  /** Semantic search across all indexed documents */
  async search(
    query: string,
    projectId?: string,
    entity?: string,
    limit = 10,
  ): Promise<Array<{ id: string; projectId: string; entity: string; title: string; content: string; score: number }>> {
    if (!(await this.ensureReady())) {
      throw new Error('RAG not available. Is the embedding server running?');
    }

    const vector = await this.getEmbedding(query);

    const queryBuilder = this.table!.search(vector).limit(limit * 3); // Overfetch for filtering

    const results = await queryBuilder.toArray();

    // Apply filters and map
    return results
      .filter((row) => {
        if (projectId && row.projectId !== projectId) return false;
        if (entity && row.entity !== entity) return false;
        return row.id !== '__init__';
      })
      .slice(0, limit)
      .map((row) => ({
        id: row.id as string,
        projectId: row.projectId as string,
        entity: row.entity as string,
        title: row.title as string,
        content: row.content as string,
        score: row._distance != null ? 1 - (row._distance as number) : 0,
      }));
  }

  /** Full reindex of all indexable entities */
  async reindex(projectId?: string): Promise<{ indexed: number; entities: Record<string, number> }> {
    if (!(await this.ensureReady())) {
      throw new Error('RAG not available. Is the embedding server running?');
    }

    const db = this.connection.db;
    if (!db) throw new Error('MongoDB not available');

    // Clear existing data for the scope
    if (projectId) {
      await this.table!.delete(`projectId = "${projectId}"`);
    } else {
      // Full reindex: drop and recreate table
      await this.db!.dropTable('documents');
      const zeroVector = new Array(this.dimensions).fill(0);
      this.table = await this.db!.createTable('documents', [
        { id: '__init__', projectId: '__init__', entity: '__init__', title: '__init__', content: '__init__', vector: zeroVector },
      ]);
      await this.table.delete('id = "__init__"');
    }

    let totalIndexed = 0;
    const entityCounts: Record<string, number> = {};

    for (const entity of INDEXABLE_ENTITIES) {
      this.logger.log(`Reindexing ${entity}...`);
      const collection = ENTITY_COLLECTION_MAP[entity];
      const filter: Record<string, unknown> = {};
      if (projectId) {
        const { ObjectId } = await import('mongodb');
        filter.projectId = new ObjectId(projectId);
      }

      const cursor = db.collection(collection).find(filter);
      let count = 0;

      // Process in batches
      const batch: RagDocument[] = [];
      for await (const doc of cursor) {
        const extracted = this.extractText(entity, doc as Record<string, unknown>);
        if (!extracted || (!extracted.title && !extracted.content)) continue;

        const combinedText = `${extracted.title}\n${extracted.content}`.trim();
        const vector = await this.getEmbedding(combinedText);

        batch.push({
          id: String(doc._id),
          projectId: String(doc.projectId || ''),
          entity,
          title: extracted.title,
          content: extracted.content.slice(0, 2000),
          vector,
        });
        count++;

        // Flush batch every 50 documents
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
        entities: {},
      };
    }

    const allRows = await this.table.search(new Array(this.dimensions).fill(0)).limit(100000).toArray();
    const validRows = allRows.filter((r) => r.id !== '__init__');

    const entities: Record<string, number> = {};
    for (const row of validRows) {
      const e = row.entity as string;
      entities[e] = (entities[e] || 0) + 1;
    }

    return {
      ready: true,
      activeEndpoint: { provider: this.embeddingProvider, model: this.embeddingModel, url: this.embeddingUrl },
      endpoints: this.endpoints,
      dimensions: this.dimensions,
      documentCount: validRows.length,
      entities,
    };
  }
}
