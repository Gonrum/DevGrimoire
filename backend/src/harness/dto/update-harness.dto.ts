import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { HarnessSectionDto } from './harness-section.dto';

/**
 * Scope and owner are immutable once a harness exists — moving a harness
 * between levels is a create/delete, not an update, otherwise the partial
 * unique indexes can be sidestepped.
 */
export class UpdateHarnessDto {
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
