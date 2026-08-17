import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { HARNESS_SCOPES, HarnessScope } from '../harness.types';
import { HarnessSectionDto } from './harness-section.dto';

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * Ties the owner reference to the scope in both directions: the matching owner
 * is required, every other owner must be absent. Without the second half a
 * global harness could carry a stray projectId and the partial unique indexes
 * would silently not apply to it.
 */
@ValidatorConstraint({ name: 'harnessScopeOwner', async: false })
export class HarnessScopeOwnerConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const scope = (args.object as CreateHarnessDto).scope;
    const requiredFor: HarnessScope = args.property === 'projectId' ? 'project' : 'customer';

    if (scope === requiredFor) {
      return typeof value === 'string' && OBJECT_ID.test(value);
    }
    return value === undefined || value === null;
  }

  defaultMessage(args: ValidationArguments): string {
    const requiredFor = args.property === 'projectId' ? 'project' : 'customer';
    return `${args.property} is required for scope '${requiredFor}' and must be omitted otherwise`;
  }
}

export class CreateHarnessDto {
  @IsIn(HARNESS_SCOPES)
  scope: HarnessScope;

  // No @IsOptional() on the owners: the constraint itself has to see
  // `undefined` to reject a missing owner for the matching scope.
  @Validate(HarnessScopeOwnerConstraint)
  projectId?: string;

  @Validate(HarnessScopeOwnerConstraint)
  customerId?: string;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HarnessSectionDto)
  @IsOptional()
  sections?: HarnessSectionDto[];
}
