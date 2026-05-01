import { IsString, IsOptional, IsEnum, IsBoolean, IsDateString, IsMongoId } from 'class-validator';

enum GitProviderEnum {
  GITHUB = 'github',
  GITLAB = 'gitlab',
}

export class GitRepositoryDto {
  // Mongoose auto-generates `_id` on embedded subdocs ({ _id: true }), so the
  // frontend echoes it back on every save. Accept it here so the whitelist
  // doesn't reject re-submissions of existing repos.
  @IsMongoId()
  @IsOptional()
  _id?: string;

  @IsEnum(GitProviderEnum)
  provider: 'github' | 'gitlab';

  @IsString()
  @IsOptional()
  label?: string;

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

  @IsDateString()
  @IsOptional()
  lastSyncAt?: string;

  @IsString()
  @IsOptional()
  lastSyncSha?: string;

  @IsString()
  @IsOptional()
  lastEtag?: string;
}
