import { IsString, IsOptional, IsArray } from 'class-validator';

export class UpdateChangelogDto {
  @IsString()
  @IsOptional()
  version?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  changes?: string[];

  @IsString()
  @IsOptional()
  summary?: string;

  @IsString()
  @IsOptional()
  component?: string;
}
