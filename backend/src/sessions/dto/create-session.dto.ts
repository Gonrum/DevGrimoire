import { IsString, IsOptional, IsArray, IsMongoId } from 'class-validator';

export class CreateSessionDto {
  @IsMongoId()
  projectId: string;

  @IsString()
  summary: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  filesChanged?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  nextSteps?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  openQuestions?: string[];
}
