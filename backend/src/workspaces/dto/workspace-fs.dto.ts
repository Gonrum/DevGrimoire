import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/** Workspace-relative path rule shared by DTOs and the query-parameter checks. */
export function isRelativeWorkspacePath(value: unknown): boolean {
  return typeof value === 'string' && !value.includes('\0') && !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value);
}

@ValidatorConstraint({ name: 'relativeWorkspacePath', async: false })
class RelativeWorkspacePath implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isRelativeWorkspacePath(value);
  }

  defaultMessage(): string {
    return 'path must be relative to the workspace and must not contain NUL';
  }
}

const PATH_MAX = 4096;

export class FsPathDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PATH_MAX)
  @Validate(RelativeWorkspacePath)
  path: string;
}

export class FsWriteDto extends FsPathDto {
  @IsString()
  content: string;

  /**
   * `string | null`, never undefined: the sidecar rejects an omitted field.
   * `@IsOptional()` is deliberately NOT used, it would let `undefined` pass.
   */
  @ValidateIf((_obj, value) => value !== null)
  @IsString()
  baseHash: string | null;

  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class FsMoveDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PATH_MAX)
  @Validate(RelativeWorkspacePath)
  from: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(PATH_MAX)
  @Validate(RelativeWorkspacePath)
  to: string;
}

export class FsSearchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  query: string;

  @IsOptional()
  @IsBoolean()
  regex?: boolean;

  @IsOptional()
  @IsBoolean()
  caseSensitive?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  include?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  exclude?: string[];
}
