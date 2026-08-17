import { IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export const SEARCH_PROVIDER_TYPES = ['searxng', 'tavily', 'brave', 'serpapi'] as const;
export type SearchProviderType = (typeof SEARCH_PROVIDER_TYPES)[number];

export function isValidProviderType(value: unknown): value is SearchProviderType {
  return typeof value === 'string' && (SEARCH_PROVIDER_TYPES as readonly string[]).includes(value);
}

/** Incoming shape when setting config. `apiKey` semantics: `undefined` = keep
 *  previous key, `""` = delete key, non-empty = encrypt and store. */
export interface ProviderConfig {
  type: SearchProviderType;
  baseUrl?: string;
  apiKey?: string;
}

/** Persisted shape in the settings DB — `apiKey` is encrypted, never plaintext. */
export interface StoredProviderConfig {
  type: SearchProviderType;
  baseUrl?: string;
  apiKeyEnc?: string;
}

/** Public-safe representation returned by GET — the key is never leaked. */
export interface PublicWebSearchConfig {
  activeProvider: SearchProviderType;
  providers: Array<{ type: SearchProviderType; baseUrl?: string; hasApiKey: boolean }>;
}

export class ProviderConfigDto {
  @IsIn(SEARCH_PROVIDER_TYPES)
  type: SearchProviderType;

  @IsOptional()
  @IsString()
  baseUrl?: string;

  /**
   * API-Key im Klartext. Wird beim PUT akzeptiert, beim GET NIE zurückgegeben
   * (nur `hasApiKey: true/false`). `undefined` beim Update = unverändert,
   * explizit leerer String `""` = Key löschen.
   */
  @IsOptional()
  @IsString()
  apiKey?: string;
}

export class UpdateWebSearchConfigDto {
  @IsIn(SEARCH_PROVIDER_TYPES)
  activeProvider: SearchProviderType;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProviderConfigDto)
  providers: ProviderConfigDto[];
}

/** Body for `POST /web-search/config/test` — same shape as a single provider entry. */
export class TestProviderConfigDto extends ProviderConfigDto {}
