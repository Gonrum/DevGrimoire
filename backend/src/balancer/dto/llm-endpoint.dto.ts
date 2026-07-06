import {
  IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min,
} from 'class-validator';
import { LLM_PROVIDER_KINDS, LLM_PURPOSES, LlmProviderKind, LlmPurpose } from '../balancer.types';

export class LlmEndpointDto {
  @IsString() label: string;
  @IsIn(LLM_PROVIDER_KINDS as unknown as string[]) provider: LlmProviderKind;
  @IsString() baseUrl: string;
  @IsString() model: string;
  @IsOptional() @IsString() apiKey?: string;
  @IsArray() @IsIn(LLM_PURPOSES as unknown as string[], { each: true }) purposes: LlmPurpose[];
  @IsOptional() @IsBoolean() visionCapable?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(16) concurrency?: number;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsInt() @Min(0) timeoutMs?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
