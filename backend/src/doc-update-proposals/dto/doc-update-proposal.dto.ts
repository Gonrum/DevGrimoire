import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsMongoId,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  DocProposalChangeMode,
  DocProposalSourceType,
  DocProposalStatus,
  DocProposalTargetType,
} from '../schemas/doc-update-proposal.schema';

export class DocProposalSourceDto {
  @IsEnum(DocProposalSourceType)
  type: DocProposalSourceType;

  @IsString()
  id: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @IsString()
  @MaxLength(2000)
  summary: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  changedFiles?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class DocProposalTargetDto {
  @IsEnum(DocProposalTargetType)
  type: DocProposalTargetType;

  @IsOptional()
  @IsMongoId()
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  path?: string;

  @IsString()
  @MaxLength(300)
  title: string;
}

export class DocProposalSuggestedChangeDto {
  @IsEnum(DocProposalChangeMode)
  mode: DocProposalChangeMode;

  @IsString()
  @MaxLength(2000)
  summary: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  diff?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  instructions?: string;
}

export class CreateDocUpdateProposalDto {
  @IsMongoId()
  projectId: string;

  @ValidateNested()
  @Type(() => DocProposalSourceDto)
  source: DocProposalSourceDto;

  @ValidateNested()
  @Type(() => DocProposalTargetDto)
  target: DocProposalTargetDto;

  @IsString()
  @MaxLength(1000)
  reason: string;

  @IsNumber()
  @Min(0)
  @Max(10)
  confidence: number;

  @ValidateNested()
  @Type(() => DocProposalSuggestedChangeDto)
  suggestedChange: DocProposalSuggestedChangeDto;

  @IsOptional()
  @IsEnum(['system', 'agent', 'user'])
  createdBy?: 'system' | 'agent' | 'user';

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ListDocUpdateProposalsDto {
  @IsOptional()
  @IsMongoId()
  projectId?: string;

  @IsOptional()
  @IsEnum(DocProposalStatus)
  status?: DocProposalStatus;

  @IsOptional()
  @IsEnum(DocProposalSourceType)
  sourceType?: DocProposalSourceType;

  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsEnum(DocProposalTargetType)
  targetType?: DocProposalTargetType;

  @IsOptional()
  @IsMongoId()
  targetId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;
}

export class UpdateDocUpdateProposalStatusDto {
  @IsEnum(DocProposalStatus)
  status: DocProposalStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ConvertDocProposalToTodoDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  priority?: 'low' | 'medium' | 'high' | 'critical';

  @IsOptional()
  @IsMongoId()
  milestoneId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
