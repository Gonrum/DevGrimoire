import {
  IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min,
} from 'class-validator';
import { LLM_PROVIDER_KINDS, LLM_PURPOSES, LlmProviderKind, LlmPurpose } from '../balancer.types';

export class LlmEndpointDto {
  @IsString() label: string;
  @IsIn(LLM_PROVIDER_KINDS) provider: LlmProviderKind;
  @IsString() baseUrl: string;
  @IsString() model: string;
  @IsOptional() @IsString() apiKey?: string;
  @IsArray() @IsIn(LLM_PURPOSES, { each: true }) purposes: LlmPurpose[];
  @IsOptional() @IsBoolean() visionCapable?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(16) concurrency?: number;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsInt() @Min(0) timeoutMs?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

/**
 * Probe an endpoint that may not be saved yet (add-form) — tests connectivity
 * and lists the models the upstream advertises. `apiKey` undefined + `id` set
 * falls back to the stored key so editing an existing endpoint can be probed
 * without re-entering the key.
 */
export class ProbeEndpointDto {
  @IsIn(LLM_PROVIDER_KINDS) provider: LlmProviderKind;
  @IsString() baseUrl: string;
  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsString() id?: string;
}
