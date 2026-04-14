import { IsString, IsOptional, IsEmail, IsEnum, IsBoolean, ValidateNested, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { LlmMode } from '../schemas/user.schema';

export class LlmConfigDto {
  @IsEnum(LlmMode)
  @IsOptional()
  mode?: LlmMode;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  endpoint?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  model?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  apiKey?: string;

  @IsBoolean()
  @IsOptional()
  fallbackEnabled?: boolean;
}

export class UpdateProfileDto {
  @IsString()
  @IsOptional()
  username?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @ValidateNested()
  @Type(() => LlmConfigDto)
  @IsOptional()
  llmConfig?: LlmConfigDto;
}
