import { IsString, IsOptional, IsArray, IsMongoId } from 'class-validator';

export class CreateKnowledgeDto {
  @IsMongoId()
  projectId: string;

  @IsString()
  topic: string;

  @IsString()
  content: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}
