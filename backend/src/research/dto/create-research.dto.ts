import { IsString, IsOptional, IsArray, IsMongoId, IsIn } from 'class-validator';
import { ALL_SENSITIVITY_LEVELS, SensitivityLevel } from '../../common/sensitivity';

export class CreateResearchDto {
  @IsMongoId()
  @IsOptional()
  projectId?: string;

  @IsMongoId()
  @IsOptional()
  customerId?: string;

  @IsString()
  title: string;

  @IsString()
  content: string;

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
