import { IsArray, IsBoolean, IsEnum, IsMongoId, IsNumber, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ValidationReportStatus } from '../schemas/validation-report.schema';

export class CreateValidationReportDto {
  @IsMongoId()
  projectId: string;

  @IsOptional()
  @IsMongoId()
  todoId?: string;

  @IsOptional()
  @IsMongoId()
  commitId?: string;

  @IsOptional()
  @IsMongoId()
  workflowRunId?: string;

  @IsString()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  command?: string;

  @IsEnum(ValidationReportStatus)
  status: ValidationReportStatus;

  @IsOptional()
  @IsNumber()
  exitCode?: number;

  @IsOptional()
  @IsNumber()
  durationMs?: number;

  @IsOptional()
  @IsBoolean()
  truncated?: boolean;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsString()
  outputSnippet?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ListValidationReportsDto {
  @IsOptional()
  @IsMongoId()
  projectId?: string;

  @IsOptional()
  @IsMongoId()
  todoId?: string;

  @IsOptional()
  @IsMongoId()
  commitId?: string;

  @IsOptional()
  @IsMongoId()
  workflowRunId?: string;

  @IsOptional()
  @IsEnum(ValidationReportStatus)
  status?: ValidationReportStatus;

  @IsOptional()
  @Transform(({ value }) => value === undefined ? undefined : Number(value))
  @IsNumber()
  limit?: number;
}
