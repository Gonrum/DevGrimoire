import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
} from 'class-validator';
import { UserRole } from '../schemas/user.schema';
import { ALL_PERMISSIONS, type ScopeMode } from '../../common/permissions';

export class UpdateUserDto {
  @IsString()
  @IsOptional()
  username?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole;

  @IsBoolean()
  @IsOptional()
  active?: boolean;

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
