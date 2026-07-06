import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { EncryptionService } from '../common/encryption.service';
import { LlmEndpointsService, LlmEndpointInput } from './llm-endpoints.service';
import { LlmProviderKind, LlmPurpose } from './balancer.types';

const MIGRATED_FLAG = 'llm_registry_migrated_v1';

interface DecodedEndpoint {
  provider: string; url: string; model: string; apiKey?: string; visionCapable?: boolean;
}
export interface MigratedEndpoint extends LlmEndpointInput {}

function normProvider(p: string): LlmProviderKind {
  if (p === 'lmstudio') return 'openai-compatible';
  if (p === 'openai-compatible' || p === 'anthropic' || p === 'openai' || p === 'ollama') return p;
  return 'openai-compatible';
}
function key(e: { provider: string; url: string; model: string }): string {
  return `${normProvider(e.provider)}\0${e.url.replace(/\/$/, '')}\0${e.model}`;
}

/** Pure dedup/merge — exported for the unit check. */
export function mergeMigrated(
  chat: DecodedEndpoint[], embed: DecodedEndpoint[], workflow: DecodedEndpoint[],
): MigratedEndpoint[] {
  const byKey = new Map<string, MigratedEndpoint>();
  const add = (e: DecodedEndpoint, purpose: LlmPurpose, idx: number) => {
    const k = key(e);
    let ep = byKey.get(k);
    if (!ep) {
      ep = {
        label: `${normProvider(e.provider)} ${e.model}`,
        provider: normProvider(e.provider),
        baseUrl: e.url.replace(/\/$/, ''),
        model: e.model,
        apiKey: e.apiKey,
        purposes: [],
        visionCapable: !!e.visionCapable,
        priority: idx,
        concurrency: 1,
        enabled: true,
      };
      byKey.set(k, ep);
    }
    if (!ep.purposes.includes(purpose)) ep.purposes.push(purpose);
    if (e.visionCapable) ep.visionCapable = true;
    if (e.apiKey && !ep.apiKey) ep.apiKey = e.apiKey;
    return ep;
  };
  chat.forEach((e, i) => add(e, 'chat', i));
  embed.forEach((e, i) => add(e, 'embedding', i));
  workflow.forEach((e, i) => add(e, 'workflow', i));
  return [...byKey.values()];
}

@Injectable()
export class LlmRegistryMigrator implements OnModuleInit {
  private readonly logger = new Logger(LlmRegistryMigrator.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly encryption: EncryptionService,
    private readonly endpoints: LlmEndpointsService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.MCP_STDIO === 'true') return; // only the HTTP backend migrates
    const done = await this.settings.get(MIGRATED_FLAG);
    if (done === 'true') return;

    try {
      const chat = this.decode(await this.settings.get('chat_llm_endpoints_v2'));
      const embed = this.decode(await this.settings.get('rag_embedding_endpoints_v1'));
      const workflow = this.decodeWorkflow(await this.settings.get('workflow_agent_endpoint_v1'));

      let migrated = mergeMigrated(chat, embed, workflow);
      if (migrated.length === 0) migrated = this.seedFromEnv();

      const existing = await this.endpoints.count();
      if (existing === 0) {
        for (const ep of migrated) await this.endpoints.create(ep);
        this.logger.log(`Migrated ${migrated.length} LLM endpoint(s) into registry.`);
      }
      await this.settings.set(MIGRATED_FLAG, 'true');
    } catch (err) {
      this.logger.error(`LLM registry migration failed: ${(err as Error).message}`);
      // Do NOT set the flag — retry on next boot.
    }
  }

  private decode(raw: string | null): DecodedEndpoint[] {
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map((e) => ({
        provider: String(e.provider), url: String(e.url), model: String(e.model),
        apiKey: e.apiKeyEnc ? this.tryDecrypt(String(e.apiKeyEnc)) : undefined,
        visionCapable: !!e.visionCapable,
      }))
      .filter((e) => e.url && e.model);
  }

  private decodeWorkflow(raw: string | null): DecodedEndpoint[] {
    if (!raw) return [];
    try {
      const e = JSON.parse(raw) as Record<string, unknown>;
      if (!e.url || !e.model) return [];
      return [{
        provider: String(e.provider), url: String(e.url), model: String(e.model),
        apiKey: e.apiKeyEncrypted ? this.tryDecrypt(String(e.apiKeyEncrypted)) : undefined,
      }];
    } catch { return []; }
  }

  private tryDecrypt(enc: string): string | undefined {
    try { return this.encryption.decrypt(enc); } catch { return undefined; }
  }

  private seedFromEnv(): MigratedEndpoint[] {
    // Minimal: reuse existing env resolution shape. Chat + RAG single primaries.
    const out: MigratedEndpoint[] = [];
    if (process.env.CHAT_LLM_URL && process.env.CHAT_LLM_MODEL) {
      out.push({
        label: 'env chat', provider: normProvider(process.env.CHAT_LLM_PROVIDER || 'openai-compatible'),
        baseUrl: process.env.CHAT_LLM_URL, model: process.env.CHAT_LLM_MODEL,
        apiKey: process.env.CHAT_LLM_API_KEY, purposes: ['chat'], priority: 0, concurrency: 1, enabled: true,
      });
    }
    if (process.env.RAG_EMBEDDING_URL && process.env.RAG_EMBEDDING_MODEL) {
      out.push({
        label: 'env embed', provider: normProvider(process.env.RAG_EMBEDDING_PROVIDER || 'ollama'),
        baseUrl: process.env.RAG_EMBEDDING_URL, model: process.env.RAG_EMBEDDING_MODEL,
        apiKey: process.env.RAG_EMBEDDING_API_KEY, purposes: ['embedding'], priority: 0, concurrency: 1, enabled: true,
      });
    }
    return out;
  }
}
