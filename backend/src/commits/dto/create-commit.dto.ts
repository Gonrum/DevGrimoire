import { IsString, IsOptional, IsMongoId, IsIn, IsDateString, IsNumber } from 'class-validator';
import { GIT_PROVIDERS, GitProvider } from '../schemas/git-repository.schema';

export class CreateCommitDto {
  @IsMongoId()
  projectId: string;

  // `IsIn(GIT_PROVIDERS)` statt eines DTO-eigenen Enums: der Validator prüft
  // damit genau die Werte, die Typ und Mongoose-Schema kennen.
  @IsIn(GIT_PROVIDERS)
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
