import { IsString, IsOptional, IsEnum, IsBoolean } from 'class-validator';

enum GitProviderEnum {
  GITHUB = 'github',
  GITLAB = 'gitlab',
}

export class GitRepositoryDto {
  @IsEnum(GitProviderEnum)
  provider: 'github' | 'gitlab';

  @IsString()
  @IsOptional()
  baseUrl?: string;

  @IsString()
  @IsOptional()
  owner?: string;

  @IsString()
  @IsOptional()
  repo?: string;

  @IsString()
  @IsOptional()
  gitlabProjectId?: string;

  @IsString()
  @IsOptional()
  defaultBranch?: string;

  @IsString()
  @IsOptional()
  tokenSecretId?: string;

  @IsBoolean()
  @IsOptional()
  syncEnabled?: boolean;
}
