import {
  IsArray,
  IsBoolean,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateChatSessionDto {
  @IsMongoId()
  projectId: string;

  @IsOptional()
  @IsString()
  title?: string;
}

export class UpdateChatSessionDto {
  @IsOptional()
  @IsString()
  title?: string;
}

export class SendChatMessageDto {
  @IsString()
  content: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachmentIds?: string[];

  /**
   * Active workspace whose name/path/repo are prepended as a one-line
   * system context to the user message. Tells the agent where it is
   * working without forcing it to call workspace_get every turn.
   */
  @IsOptional()
  @IsMongoId()
  workspaceId?: string;
}

export const CHAT_PROVIDERS = [
  'lmstudio',
  'openai-compatible',
  'anthropic',
  'openai',
] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

/**
 * Providers that USED to be supported but are now transparently migrated to
 * `openai-compatible` on read. We still need to recognize these strings when
 * loading legacy configs from the DB or from env vars.
 */
export const LEGACY_CHAT_PROVIDERS = ['ollama'] as const;
export type LegacyChatProvider = (typeof LEGACY_CHAT_PROVIDERS)[number];
export function isLegacyProvider(value: string): value is LegacyChatProvider {
  return (LEGACY_CHAT_PROVIDERS as readonly string[]).includes(value);
}

export class ChatEndpointDto {
  @IsIn(CHAT_PROVIDERS as unknown as string[])
  provider: ChatProvider;

  @IsString()
  url: string;

  @IsString()
  model: string;

  /**
   * API-Key im Klartext. Wird beim PUT akzeptiert, beim GET NIE zurückgegeben
   * (nur `hasApiKey: true/false`). Leeres/undefined beim Update = unverändert,
   * explizit leerer String `""` = Key löschen.
   */
  @IsOptional()
  @IsString()
  apiKey?: string;

  /** Nur Response: zeigt an ob ein Key gespeichert ist, ohne den Wert zu leaken */
  @IsOptional()
  @IsBoolean()
  hasApiKey?: boolean;

  /** Marks the endpoint as handling images (vision model loaded / cloud vision API). */
  @IsOptional()
  @IsBoolean()
  visionCapable?: boolean;
}

export class UpdateChatConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatEndpointDto)
  endpoints: ChatEndpointDto[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(32768)
  maxTokens?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  topK?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  historyLimit?: number;

  @IsOptional()
  @IsBoolean()
  toolsEnabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  toolsAllowlist?: string[];

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  toolsMaxIterations?: number;
}

export class TestChatEndpointDto extends ChatEndpointDto {}

export class PrepareChatMessageDto {
  @IsString()
  content: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachmentIds?: string[];

  @IsOptional()
  @IsMongoId()
  workspaceId?: string;
}

export class PersistedContextRefDto {
  @IsString()
  entity: string;

  @IsString()
  entityId: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsNumber()
  score?: number;
}

export class PersistedToolCallDto {
  @IsString()
  id: string;

  @IsString()
  name: string;

  @IsString()
  arguments: string;

  @IsOptional()
  @IsString()
  result?: string;

  @IsBoolean()
  success: boolean;

  @IsOptional()
  @IsString()
  error?: string;
}

export class PersistChatMessageDto {
  @IsString()
  userContent: string;

  @IsOptional()
  @IsString()
  assistantContent?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PersistedContextRefDto)
  contextRefs?: PersistedContextRefDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PersistedToolCallDto)
  toolCalls?: PersistedToolCallDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachmentIds?: string[];
}

export class ExecuteChatToolDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  arguments?: Record<string, unknown>;
}
