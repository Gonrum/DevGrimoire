import { IsString, IsOptional, IsArray } from 'class-validator';

export class CreateChangelogDto {
  @IsString()
  projectId: string;

  @IsString()
  @IsOptional()
  version?: string;

  @IsArray()
  @IsString({ each: true })
  changes: string[];

  @IsString()
  @IsOptional()
  summary?: string;

  @IsString()
  @IsOptional()
  component?: string;
}
