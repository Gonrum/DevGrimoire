import { IsString, IsOptional, IsArray } from 'class-validator';

export class UpdateKnowledgeDto {
  @IsString()
  @IsOptional()
  topic?: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}
