import { IsString, IsOptional, IsEnum, IsMongoId, IsNumberString } from 'class-validator';

export class QueryLogsDto {
  // T-338: optional — when absent the controller falls back to the
  // admin-only global view (with per-row visibility filter).
  @IsOptional()
  @IsMongoId()
  projectId?: string;

  // T-338: comma-separated list of project ids for the global view's
  // multi-select filter. Use this OR `projectId`, not both.
  @IsOptional()
  @IsString()
  projectIds?: string;

  @IsOptional()
  @IsEnum(['debug', 'info', 'warn', 'error'])
  level?: string;

  @IsOptional()
  @IsString()
  service?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @IsNumberString()
  limit?: string;

  @IsOptional()
  @IsNumberString()
  offset?: string;
}
