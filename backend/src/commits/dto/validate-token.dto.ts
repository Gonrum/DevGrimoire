import { IsString, IsOptional, IsEnum, IsBoolean } from 'class-validator';

enum GitProviderEnum {
  GITHUB = 'github',
  GITLAB = 'gitlab',
  GITEA = 'gitea',
}

export class ValidateTokenDto {
  @IsEnum(GitProviderEnum)
  provider: string;

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

  @IsBoolean()
  @IsOptional()
  allowPrivateHost?: boolean;

  @IsString()
  token: string;
}
