import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
} from 'class-validator';
import type { ScopeMode } from '../../common/permissions';

export class UpdateApiKeyDto {
  @IsString()
  @IsOptional()
  name?: string;

  // null = "all tools" (unset). [] = "no tools". [...] = whitelist.
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @IsOptional()
  allowedTools?: string[] | null;

  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @IsOptional()
  permissions?: string[];

  @IsIn(['all', 'allowlist', 'none'])
  @IsOptional()
  projectScopeMode?: ScopeMode;

  @IsArray()
  @IsMongoId({ each: true })
  @ArrayUnique()
  @IsOptional()
  allowedProjectIds?: string[];

  @IsIn(['all', 'allowlist', 'none'])
  @IsOptional()
  customerScopeMode?: ScopeMode;

  @IsArray()
  @IsMongoId({ each: true })
  @ArrayUnique()
  @IsOptional()
  allowedCustomerIds?: string[];
}
