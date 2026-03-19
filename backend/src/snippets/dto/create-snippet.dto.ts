import { IsString, IsOptional, IsArray, IsMongoId } from 'class-validator';

export class CreateSnippetDto {
  @IsMongoId()
  projectId: string;

  @IsString()
  title: string;

  @IsString()
  language: string;

  @IsString()
  code: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  category?: string;

  @IsString()
  @IsOptional()
  fileName?: string;
}
