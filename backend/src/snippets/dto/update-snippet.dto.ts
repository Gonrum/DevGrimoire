import { IsString, IsOptional, IsArray } from 'class-validator';

export class UpdateSnippetDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  language?: string;

  @IsString()
  @IsOptional()
  code?: string;

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
