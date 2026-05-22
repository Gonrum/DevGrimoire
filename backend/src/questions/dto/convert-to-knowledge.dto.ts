import { IsString, IsOptional, IsArray, IsIn } from 'class-validator';

export class ConvertToKnowledgeDto {
  @IsString()
  topic: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsString()
  @IsOptional()
  category?: string;

  @IsIn(['global', 'project'])
  @IsOptional()
  scope?: 'global' | 'project';
}
