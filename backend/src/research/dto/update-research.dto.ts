import { IsString, IsOptional, IsArray, IsIn } from 'class-validator';
import { ALL_SENSITIVITY_LEVELS, SensitivityLevel } from '../../common/sensitivity';

export class UpdateResearchDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  sources?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsIn(ALL_SENSITIVITY_LEVELS)
  @IsOptional()
  sensitivity?: SensitivityLevel;
}
