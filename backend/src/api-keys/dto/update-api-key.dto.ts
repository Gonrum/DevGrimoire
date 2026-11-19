import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
} from 'class-validator';
import { ALL_PERMISSIONS, type ScopeMode } from '../../common/permissions';

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
  // Unknown names are rejected: a typo would otherwise silently shrink the
  // allowlist and lock the key out without any visible reason.
  @IsIn(ALL_PERMISSIONS, { each: true })
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
