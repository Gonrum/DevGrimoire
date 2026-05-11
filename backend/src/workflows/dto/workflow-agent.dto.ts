import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min, Max } from 'class-validator';

export type WorkflowAgentProvider = 'lmstudio' | 'openai-compatible' | 'openai' | 'anthropic';

export class UpdateWorkflowAgentConfigDto {
  @IsEnum(['lmstudio', 'openai-compatible', 'openai', 'anthropic'])
  provider: WorkflowAgentProvider;

  @IsString()
  url: string;

  @IsString()
  model: string;

  /**
   * undefined → keep existing; '' → delete; non-empty → encrypt and store.
   * Mirrors ChatLlmService.setEndpoints semantics.
   */
  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsBoolean()
  toolsEnabled: boolean;

  @IsInt()
  @Min(1)
  @Max(20)
  maxToolIterations: number;
}

export interface WorkflowAgentConfigPublic {
  provider: WorkflowAgentProvider;
  url: string;
  model: string;
  hasApiKey: boolean;
  toolsEnabled: boolean;
  maxToolIterations: number;
}
