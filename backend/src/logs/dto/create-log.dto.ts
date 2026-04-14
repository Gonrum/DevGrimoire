import { IsString, IsOptional, IsEnum, IsObject, IsArray, IsMongoId } from 'class-validator';

export class CreateLogDto {
  @IsMongoId()
  projectId: string;

  @IsOptional()
  @IsEnum(['debug', 'info', 'warn', 'error'])
  level?: string;

  @IsString()
  message: string;

  @IsOptional()
  @IsString()
  service?: string;

  @IsOptional()
  @IsString()
  area?: string;

  @IsOptional()
  @IsEnum(['production', 'staging', 'development', 'test'])
  environment?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  source?: string;
}
