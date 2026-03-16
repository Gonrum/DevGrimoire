import { IsString, IsOptional, IsArray, IsBoolean } from 'class-validator';

export class UpdateProjectDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  path?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  techStack?: string[];

  @IsString()
  @IsOptional()
  repository?: string;

  @IsBoolean()
  @IsOptional()
  active?: boolean;

  @IsBoolean()
  @IsOptional()
  favorite?: boolean;

  @IsString()
  @IsOptional()
  instructions?: string;

  @IsArray()
  @IsOptional()
  components?: { name: string; version: string; path?: string }[];

  @IsString()
  @IsOptional()
  todoNumberFormat?: string;

  @IsString()
  @IsOptional()
  milestoneNumberFormat?: string;

  @IsArray()
  @IsOptional()
  gitRepositories?: {
    provider: 'github' | 'gitlab';
    baseUrl?: string;
    owner?: string;
    repo?: string;
    gitlabProjectId?: string;
    defaultBranch?: string;
    tokenSecretId?: string;
    syncEnabled?: boolean;
  }[];
}
