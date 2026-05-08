import { IsString, IsOptional, IsArray, IsMongoId, IsIn } from 'class-validator';
import { ALL_SENSITIVITY_LEVELS, SensitivityLevel } from '../../common/sensitivity';

export class UpdateAttachmentDto {
  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  entityType?: string;

  @IsMongoId()
  @IsOptional()
  entityId?: string;

  @IsIn(ALL_SENSITIVITY_LEVELS)
  @IsOptional()
  sensitivity?: SensitivityLevel;
}
