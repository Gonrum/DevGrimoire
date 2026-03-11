import { IsString, IsOptional, IsEnum, IsArray } from 'class-validator';
import { FeatureStatus, FeaturePriority } from '../schemas/feature.schema';

export class CreateFeatureDto {
  @IsString()
  projectId: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsEnum(FeatureStatus)
  status?: FeatureStatus;

  @IsOptional()
  @IsString()
  version?: string;

  @IsOptional()
  @IsEnum(FeaturePriority)
  priority?: FeaturePriority;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
