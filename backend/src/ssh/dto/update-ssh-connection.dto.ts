import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CreateSshConnectionInlineSecretsDto } from './create-ssh-connection.dto';

/**
 * Update only patches metadata fields by default. Credential rotation is a
 * separate code path triggered by setting `inlineSecrets` (the service will
 * create new Secrets, swap the references, and cascade-delete the old
 * `ownedBy`-marked secrets).
 */
export class UpdateSshConnectionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(253)
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  notifyOnAuthFailure?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateSshConnectionInlineSecretsDto)
  inlineSecrets?: CreateSshConnectionInlineSecretsDto;
}
