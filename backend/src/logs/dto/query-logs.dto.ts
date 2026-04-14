import { IsString, IsOptional, IsEnum, IsMongoId, IsNumberString } from 'class-validator';

export class QueryLogsDto {
  @IsMongoId()
  projectId: string;

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
