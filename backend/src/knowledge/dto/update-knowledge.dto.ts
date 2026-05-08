import { IsString, IsOptional, IsArray, IsIn } from 'class-validator';
import { ALL_SENSITIVITY_LEVELS, SensitivityLevel } from '../../common/sensitivity';

export class UpdateKnowledgeDto {
  @IsString()
  @IsOptional()
  topic?: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  category?: string;

  @IsIn(ALL_SENSITIVITY_LEVELS)
  @IsOptional()
  sensitivity?: SensitivityLevel;
}
