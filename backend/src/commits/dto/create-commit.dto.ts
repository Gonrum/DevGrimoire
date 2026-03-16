import { IsString, IsOptional, IsMongoId, IsEnum, IsDateString, IsNumber } from 'class-validator';
import { GitProvider } from '../schemas/commit.schema';

export class CreateCommitDto {
  @IsMongoId()
  projectId: string;

  @IsEnum(GitProvider)
  provider: GitProvider;

  @IsString()
  sha: string;

  @IsString()
  message: string;

  @IsString()
  authorName: string;

  @IsString()
  @IsOptional()
  authorEmail?: string;

  @IsDateString()
  committedAt: string;

  @IsString()
  @IsOptional()
  url?: string;

  @IsString()
  @IsOptional()
  branch?: string;

  @IsNumber()
  @IsOptional()
  additions?: number;

  @IsNumber()
  @IsOptional()
  deletions?: number;
}
