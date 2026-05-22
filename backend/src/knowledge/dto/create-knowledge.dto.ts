import {
  IsString,
  IsOptional,
  IsArray,
  IsMongoId,
  IsIn,
  ValidateIf,
} from 'class-validator';
import { ALL_SENSITIVITY_LEVELS, SensitivityLevel } from '../../common/sensitivity';

export class CreateKnowledgeDto {
  @IsMongoId()
  @ValidateIf((o) => o.scope === 'project')
  projectId?: string;

  @IsMongoId()
  @ValidateIf((o) => o.scope === 'customer')
  customerId?: string;

  @IsIn(['global', 'project', 'customer'])
  @IsOptional()
  scope?: 'global' | 'project' | 'customer';

  @IsString()
  topic: string;

  @IsString()
  content: string;

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

  @IsMongoId()
  @IsOptional()
  sourceQuestionId?: string;
}
