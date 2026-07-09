import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { SettingsService } from '../../settings/settings.service';
import { EncryptionService } from '../../common/encryption.service';
import { SearchProvider } from '../providers/search-provider.interface';
import { SearxngProvider } from '../providers/searxng.provider';
import { TavilyProvider } from '../providers/tavily.provider';
import { BraveProvider } from '../providers/brave.provider';
import { SerpApiProvider } from '../providers/serpapi.provider';
import { resolveSearxngUrl } from './searxng-url.util';
import {
  SearchProviderType,
  ProviderConfig,
  StoredProviderConfig,
  PublicWebSearchConfig,
  isValidProviderType,
} from '../dto/web-search-config.dto';

export const SETTING_WEB_SEARCH_CONFIG = 'web_search_config';

const DEFAULT_ACTIVE_PROVIDER: SearchProviderType = 'searxng';

interface StoredWebSearchConfig {
  activeProvider: SearchProviderType;
  providers: StoredProviderConfig[];
}

/**
 * Encrypted multi-provider config for web search, mirroring the
 * `chat_llm_endpoints_v2` pattern in `ChatLlmService`: API keys are encrypted
 * at rest, never returned in plaintext by the public getter, and a `""`
 * (empty string) on write is the explicit "delete this key" signal while
 * `undefined` means "leave whatever is stored untouched".
 *
 * Provider identity for the merge-on-write is the provider `type` — one
 * config entry per provider type (searxng/tavily/brave/serpapi).
 */
@Injectable()
export class WebSearchConfigService {
  private readonly logger = new Logger(WebSearchConfigService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly encryption: EncryptionService,
    private readonly http: HttpService,
  ) {}

  /** Public-safe config: never returns plaintext or encrypted keys, only `hasApiKey`. */
  async getConfig(): Promise<PublicWebSearchConfig> {
    const stored = await this.getStoredConfig();
    return this.toPublicConfig(stored);
  }

  /**
   * Persist config. Per-entry `apiKey` semantics (matches `ChatLlmService.setEndpoints`):
   * - `undefined` → keep the previously stored encrypted key for the same `type`
   * - `""` (empty string) → delete the key
   * - any non-empty string → encrypt and store (throws if encryption isn't configured)
   */
  async setConfig(input: { activeProvider: SearchProviderType; providers: ProviderConfig[] }): Promise<PublicWebSearchConfig> {
    const previous = await this.getStoredConfig();
    const prevByType = new Map(previous.providers.map((p) => [p.type, p]));

    const providers: StoredProviderConfig[] = input.providers
      .filter((p) => isValidProviderType(p.type))
      .map((p) => this.toStoredProvider(p, prevByType.get(p.type)));

    const activeProvider = isValidProviderType(input.activeProvider)
      ? input.activeProvider
      : DEFAULT_ACTIVE_PROVIDER;

    const next: StoredWebSearchConfig = { activeProvider, providers };
    await this.persist(next);
    return this.toPublicConfig(next);
  }

  /**
   * Resolve the active (or explicitly overridden) provider into a ready-to-use
   * `SearchProvider` instance. For `searxng` the URL is resolved lazily via
   * settings/env (same resolution order as the module factory). For the
   * cloud providers, the stored key is decrypted and passed along with the
   * optional `baseUrl` override.
   */
  async resolveActiveProvider(override?: SearchProviderType): Promise<SearchProvider> {
    const stored = await this.getStoredConfig();
    const type = override ?? stored.activeProvider;
    const entry = stored.providers.find((p) => p.type === type);
    const apiKey = this.decryptKey(entry?.apiKeyEnc, type);
    return this.instantiateProvider(type, apiKey, entry?.baseUrl);
  }

  /**
   * Construct a provider ad hoc from a plaintext config (never persisted) and
   * run a minimal probe search. Used by `POST /web-search/config/test` so an
   * admin can validate a key/baseUrl before saving it.
   */
  async testProvider(cfg: ProviderConfig): Promise<{ ok: boolean; count: number; error?: string }> {
    try {
      const provider = this.instantiateProvider(cfg.type, cfg.apiKey ?? '', cfg.baseUrl);
      const hits = await provider.search('test', { limit: 1 });
      return { ok: true, count: hits.length };
    } catch (err) {
      return { ok: false, count: 0, error: (err as Error).message };
    }
  }

  private instantiateProvider(type: SearchProviderType, apiKey: string, baseUrl?: string): SearchProvider {
    if (type === 'searxng') {
      const getUrl = async () => (baseUrl ? baseUrl.replace(/\/$/, '') : resolveSearxngUrl(this.settings));
      return new SearxngProvider(this.http, getUrl);
    }
    const providerCfg = { apiKey, baseUrl };
    switch (type) {
      case 'tavily':
        return new TavilyProvider(this.http, providerCfg);
      case 'brave':
        return new BraveProvider(this.http, providerCfg);
      case 'serpapi':
        return new SerpApiProvider(this.http, providerCfg);
      default:
        this.logger.warn(`Unknown provider type "${type}" — falling back to searxng`);
        return new SearxngProvider(this.http, () => resolveSearxngUrl(this.settings));
    }
  }

  private toStoredProvider(p: ProviderConfig, prev?: StoredProviderConfig): StoredProviderConfig {
    const stored: StoredProviderConfig = { type: p.type };
    if (p.baseUrl !== undefined) {
      stored.baseUrl = p.baseUrl;
    } else if (prev?.baseUrl !== undefined) {
      stored.baseUrl = prev.baseUrl;
    }

    if (p.apiKey === undefined) {
      // keep previous key untouched
      if (prev?.apiKeyEnc) stored.apiKeyEnc = prev.apiKeyEnc;
    } else if (p.apiKey === '') {
      // explicit delete — leave apiKeyEnc unset
    } else {
      if (!this.encryption.isEnabled()) {
        throw new Error(
          'Cannot store API key: SECRETS_ENCRYPTION_KEY is not configured. ' +
            'Set it in .env before configuring cloud search providers.',
        );
      }
      stored.apiKeyEnc = this.encryption.encrypt(p.apiKey);
    }
    return stored;
  }

  private decryptKey(apiKeyEnc: string | undefined, type: SearchProviderType): string {
    if (!apiKeyEnc) return '';
    try {
      return this.encryption.decrypt(apiKeyEnc);
    } catch (err) {
      this.logger.error(`Failed to decrypt API key for ${type}: ${(err as Error).message}`);
      return '';
    }
  }

  private toPublicConfig(stored: StoredWebSearchConfig): PublicWebSearchConfig {
    return {
      activeProvider: stored.activeProvider,
      providers: stored.providers.map((p) => ({
        type: p.type,
        baseUrl: p.baseUrl,
        hasApiKey: !!p.apiKeyEnc,
      })),
    };
  }

  private async getStoredConfig(): Promise<StoredWebSearchConfig> {
    const raw = await this.settings.get(SETTING_WEB_SEARCH_CONFIG);
    if (!raw) return { activeProvider: DEFAULT_ACTIVE_PROVIDER, providers: [] };
    try {
      const parsed = JSON.parse(raw) as { activeProvider?: unknown; providers?: unknown };
      const activeProvider = isValidProviderType(parsed.activeProvider)
        ? parsed.activeProvider
        : DEFAULT_ACTIVE_PROVIDER;
      const providers = Array.isArray(parsed.providers)
        ? parsed.providers.filter(
            (p): p is StoredProviderConfig =>
              !!p && typeof p === 'object' && isValidProviderType((p as StoredProviderConfig).type),
          )
        : [];
      return { activeProvider, providers };
    } catch {
      this.logger.warn(`Malformed ${SETTING_WEB_SEARCH_CONFIG} JSON — ignoring`);
      return { activeProvider: DEFAULT_ACTIVE_PROVIDER, providers: [] };
    }
  }

  private async persist(cfg: StoredWebSearchConfig): Promise<void> {
    await this.settings.set(SETTING_WEB_SEARCH_CONFIG, JSON.stringify(cfg));
  }
}
