import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CreateSshConnectionInlineSecretsDto } from './create-ssh-connection.dto';

/**
 * Update patches metadata by default. Credential rotation is triggered by
 * setting either `inlineSecrets` (service creates new owned Secrets) or by
 * setting one of `privateKeySecretId` / `passwordSecretId` (pick-existing).
 * `authMethod` may switch atomically with the rotation; the service
 * cascades-deletes the previously-owned secrets either way.
 */
export class UpdateSshConnectionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label?: string;

  // Slug rename is allowed — the service guards against duplicates via the
  // unique index and surfaces a 409 if the new slug clashes.
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be kebab-case, [a-z0-9-]',
  })
  slug?: string;

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

  // Per-connection SFTP upload cap in bytes. Server clamps to [1, 500 MB].
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500 * 1024 * 1024)
  maxUploadBytes?: number;

  // ----- Credential rotation ------------------------------------------------
  @IsOptional()
  @IsIn(['key', 'password'])
  authMethod?: 'key' | 'password';

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateSshConnectionInlineSecretsDto)
  inlineSecrets?: CreateSshConnectionInlineSecretsDto;

  // Pick-existing rotation path.
  @IsOptional()
  @IsMongoId()
  privateKeySecretId?: string;

  @IsOptional()
  @IsMongoId()
  passphraseSecretId?: string;

  @IsOptional()
  @IsMongoId()
  passwordSecretId?: string;
}
