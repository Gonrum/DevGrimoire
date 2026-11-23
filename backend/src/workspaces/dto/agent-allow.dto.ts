import { IsOptional, IsString } from 'class-validator';

/**
 * Deliberately loose: the semantic validation (kind/match/value rules) lives in
 * `parseAgentAllowInput`, which answers with a 400 and a precise message.
 */
export class AddAgentAllowDto {
  @IsString()
  kind: string;

  @IsOptional()
  @IsString()
  match?: string;

  @IsOptional()
  @IsString()
  value?: string;
}
