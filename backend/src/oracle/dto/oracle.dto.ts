import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { OracleSeverity, OracleSuggestionStatus, OracleRiskType } from '../schemas/oracle-suggestion.schema';

export class ListOracleSuggestionsDto {
  @IsOptional()
  @IsMongoId()
  projectId?: string;

  @IsOptional()
  @IsEnum(OracleSuggestionStatus)
  status?: OracleSuggestionStatus;

  @IsOptional()
  @IsEnum(OracleSeverity)
  severity?: OracleSeverity;

  @IsOptional()
  @IsEnum(OracleRiskType)
  type?: OracleRiskType;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;
}

export class UpdateOracleStatusDto {
  @IsEnum(OracleSuggestionStatus)
  status: OracleSuggestionStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ConvertOracleToTodoDto {
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

export class CommentOracleOnTodoDto {
  @IsOptional()
  @IsMongoId()
  todoId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
