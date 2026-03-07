import { IsString, IsOptional, IsArray, IsBoolean, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class EnvVariableDto {
  @IsString()
  key: string;

  @IsString()
  value: string;
}

export class UpdateEnvironmentDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EnvVariableDto)
  @IsOptional()
  variables?: EnvVariableDto[];

  @IsBoolean()
  @IsOptional()
  active?: boolean;
}
