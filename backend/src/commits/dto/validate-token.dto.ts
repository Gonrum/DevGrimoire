import { IsString, IsOptional, IsEnum } from 'class-validator';

enum GitProviderEnum {
  GITHUB = 'github',
  GITLAB = 'gitlab',
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

  @IsString()
  token: string;
}
