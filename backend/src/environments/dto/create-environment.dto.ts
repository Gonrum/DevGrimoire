import { IsString, IsOptional, IsArray, IsBoolean, IsMongoId, IsNumber, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class EnvVariableDto {
  @IsString()
  key: string;

  @IsString()
  value: string;
}

export class CreateEnvironmentDto {
  @IsMongoId()
  projectId: string;

  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  host?: string;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  port?: number;

  @IsString()
  @IsOptional()
  user?: string;

  @IsString()
  @IsOptional()
  url?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EnvVariableDto)
  @IsOptional()
  variables?: EnvVariableDto[];

  @IsBoolean()
  @IsOptional()
  active?: boolean;
}
