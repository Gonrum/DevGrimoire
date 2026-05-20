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
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Inline credential payload for "Quick-Create": the backend will create the
 * referenced Secret(s) atomically with the SshConnection. Either inline OR
 * existing IDs may be provided per credential type, never both.
 */
export class CreateSshConnectionInlineKeyDto {
  @IsString()
  @MinLength(1)
  privateKey: string;

  @IsOptional()
  @IsString()
  passphrase?: string;
}

export class CreateSshConnectionInlinePasswordDto {
  @IsString()
  @MinLength(1)
  password: string;
}

export class CreateSshConnectionInlineSecretsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateSshConnectionInlineKeyDto)
  key?: CreateSshConnectionInlineKeyDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateSshConnectionInlinePasswordDto)
  password?: CreateSshConnectionInlinePasswordDto;
}

export class CreateSshConnectionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label: string;

  // kebab-case, 3-60 chars, [a-z0-9-]
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be kebab-case, [a-z0-9-]',
  })
  slug: string;

  // Exactly one of customerId / projectId must be set (enforced in service).
  @IsOptional()
  @IsMongoId()
  customerId?: string;

  @IsOptional()
  @IsMongoId()
  projectId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(253)
  host: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  port?: number;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username: string;

  @IsIn(['key', 'password'])
  authMethod: 'key' | 'password';

  // Pick-existing path: caller provides Secret IDs already in scope.
  @IsOptional()
  @IsMongoId()
  privateKeySecretId?: string;

  @IsOptional()
  @IsMongoId()
  passphraseSecretId?: string;

  @IsOptional()
  @IsMongoId()
  passwordSecretId?: string;

  // Quick-create path: backend creates the secrets in this request.
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateSshConnectionInlineSecretsDto)
  inlineSecrets?: CreateSshConnectionInlineSecretsDto;

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
}
