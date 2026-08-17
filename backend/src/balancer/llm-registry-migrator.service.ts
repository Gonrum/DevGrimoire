import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { EncryptionService } from '../common/encryption.service';
import { LlmEndpointsService, LlmEndpointInput } from './llm-endpoints.service';
import { LlmPurpose, toProviderKind } from './balancer.types';
import { errorMessage, isRecord, isUnknownArray } from '../common/narrow';
import { asString } from '../common/tool-args';
import { parseJsonRecord } from './llm-responses';

const MIGRATED_FLAG = 'llm_registry_migrated_v1';

/**
 * Eine aus den Alt-Settings gelesene Endpunkt-Zeile. `provider` ist hier
 * absichtlich noch `string`: das ist der ungeprüfte Wert aus der DB, verengt
 * wird er erst in `mergeMigrated` über `toProviderKind`.
 */
interface DecodedEndpoint {
  provider: string; url: string; model: string; apiKey?: string; visionCapable?: boolean;
}
export type MigratedEndpoint = LlmEndpointInput;

function key(e: { provider: string; url: string; model: string }): string {
  return `${toProviderKind(e.provider)}\0${e.url.replace(/\/$/, '')}\0${e.model}`;
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
        label: `${toProviderKind(e.provider)} ${e.model}`,
        provider: toProviderKind(e.provider),
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

      let created = 0;
      for (const ep of migrated) {
        if (await this.endpoints.existsByIdentity(ep.provider, ep.baseUrl, ep.model)) continue;
        await this.endpoints.create(ep);
        created++;
      }
      this.logger.log(`LLM registry migration: created ${created} new endpoint(s) (${migrated.length} resolved).`);
      await this.settings.set(MIGRATED_FLAG, 'true');
    } catch (err: unknown) {
      this.logger.error(`LLM registry migration failed: ${errorMessage(err)}`);
      // Do NOT set the flag — retry on next boot.
    }
  }

  /**
   * `chat_llm_endpoints_v2` / `rag_embedding_endpoints_v1` — JSON-Array.
   *
   * `Array.isArray` auf einem `unknown` verengt zu `any[]`, weshalb `e.url` und
   * `e.model` unten vorher ungeprüfte `any`-Zugriffe waren. Und `String(e.url)`
   * machte aus einem Objekt `"[object Object]"`, was die anschließende
   * Truthiness-Prüfung passierte — ein Müll-Endpunkt wurde also angelegt. Wer
   * kein String ist, gilt jetzt als nicht vorhanden.
   */
  private decode(raw: string | null): DecodedEndpoint[] {
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    if (!isUnknownArray(parsed)) return [];
    const out: DecodedEndpoint[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) continue;
      const url = asString(entry.url);
      const model = asString(entry.model);
      if (!url || !model) continue;
      const apiKeyEnc = asString(entry.apiKeyEnc);
      out.push({
        provider: asString(entry.provider) ?? '',
        url,
        model,
        apiKey: apiKeyEnc ? this.tryDecrypt(apiKeyEnc) : undefined,
        visionCapable: !!entry.visionCapable,
      });
    }
    return out;
  }

  /** `workflow_agent_endpoint_v1` — einzelnes JSON-Objekt. */
  private decodeWorkflow(raw: string | null): DecodedEndpoint[] {
    if (!raw) return [];
    const e = parseJsonRecord(raw);
    if (!e) return [];
    const url = asString(e.url);
    const model = asString(e.model);
    if (!url || !model) return [];
    const apiKeyEnc = asString(e.apiKeyEncrypted);
    return [{
      provider: asString(e.provider) ?? '',
      url,
      model,
      apiKey: apiKeyEnc ? this.tryDecrypt(apiKeyEnc) : undefined,
    }];
  }

  private tryDecrypt(enc: string): string | undefined {
    try { return this.encryption.decrypt(enc); } catch { return undefined; }
  }

  private seedFromEnv(): MigratedEndpoint[] {
    // Minimal: reuse existing env resolution shape. Chat + RAG single primaries.
    const out: MigratedEndpoint[] = [];
    if (process.env.CHAT_LLM_URL && process.env.CHAT_LLM_MODEL) {
      out.push({
        label: 'env chat', provider: toProviderKind(process.env.CHAT_LLM_PROVIDER || 'openai-compatible'),
        baseUrl: process.env.CHAT_LLM_URL, model: process.env.CHAT_LLM_MODEL,
        apiKey: process.env.CHAT_LLM_API_KEY, purposes: ['chat'], priority: 0, concurrency: 1, enabled: true,
      });
    }
    if (process.env.RAG_EMBEDDING_URL && process.env.RAG_EMBEDDING_MODEL) {
      out.push({
        label: 'env embed', provider: toProviderKind(process.env.RAG_EMBEDDING_PROVIDER || 'ollama'),
        baseUrl: process.env.RAG_EMBEDDING_URL, model: process.env.RAG_EMBEDDING_MODEL,
        apiKey: process.env.RAG_EMBEDDING_API_KEY, purposes: ['embedding'], priority: 0, concurrency: 1, enabled: true,
      });
    }
    return out;
  }
}
