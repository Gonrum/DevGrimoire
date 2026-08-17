import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  HARNESS_MERGE_STRATEGIES,
  HARNESS_SECTION_KEY_PATTERN,
  HARNESS_SECTION_KINDS,
  HarnessMergeStrategy,
  HarnessSectionKind,
} from '../harness.types';

export class HarnessSectionDto {
  @Matches(HARNESS_SECTION_KEY_PATTERN, {
    message: 'key must be kebab-case (a-z, 0-9, single dashes between segments)',
  })
  @MaxLength(64)
  key: string;

  @IsIn(HARNESS_SECTION_KINDS)
  kind: HarnessSectionKind;

  /** Omitted or empty means: inherit the title from the level below. */
  @IsString()
  @MaxLength(200)
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  body?: string;

  @IsObject()
  @IsOptional()
  payload?: Record<string, unknown>;

  @IsIn(HARNESS_MERGE_STRATEGIES)
  @IsOptional()
  mergeStrategy?: HarnessMergeStrategy;

  @IsInt()
  @IsOptional()
  order?: number;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}
