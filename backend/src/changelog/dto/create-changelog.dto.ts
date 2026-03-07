import { IsString, IsOptional, IsArray, IsMongoId } from 'class-validator';

export class CreateChangelogDto {
  @IsMongoId()
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
