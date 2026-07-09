import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ResearchFrequency } from '../schemas/research-topic.schema';

export class ResearchScopeDto {
  @IsIn(['all', 'selected'])
  mode: 'all' | 'selected';

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  projectIds?: string[];

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  customerIds?: string[];

  @IsOptional()
  @IsBoolean()
  includeGlobal?: boolean;
}

export class ResearchWebSearchConfigDto {
  @IsBoolean()
  enabled: boolean;

  @IsOptional()
  @IsString()
  provider?: string;
}

export class ResearchScheduleDto {
  @IsEnum(ResearchFrequency)
  frequency: ResearchFrequency;

  @IsInt()
  @Min(0)
  @Max(23)
  hour: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  dayOfMonth?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ResearchGuardrailsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  maxIterations?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxWebSearches?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxWebFetches?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  timeoutMs?: number;
}

export class CreateResearchTopicDto {
  @IsString()
  title: string;

  @IsString()
  brief: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResearchScopeDto)
  scope?: ResearchScopeDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResearchWebSearchConfigDto)
  webSearch?: ResearchWebSearchConfigDto;

  @ValidateNested()
  @Type(() => ResearchScheduleDto)
  schedule: ResearchScheduleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResearchGuardrailsDto)
  guardrails?: ResearchGuardrailsDto;

  @IsOptional()
  @IsMongoId()
  ownerUserId?: string;

  @IsOptional()
  @IsBoolean()
  notifyOnComplete?: boolean;
}

export class UpdateResearchTopicDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  brief?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResearchScopeDto)
  scope?: ResearchScopeDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResearchWebSearchConfigDto)
  webSearch?: ResearchWebSearchConfigDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResearchScheduleDto)
  schedule?: ResearchScheduleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResearchGuardrailsDto)
  guardrails?: ResearchGuardrailsDto;

  @IsOptional()
  @IsBoolean()
  notifyOnComplete?: boolean;
}
