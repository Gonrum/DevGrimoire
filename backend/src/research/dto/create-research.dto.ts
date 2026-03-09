import { IsString, IsOptional, IsArray, IsMongoId } from 'class-validator';

export class CreateResearchDto {
  @IsMongoId()
  projectId: string;

  @IsString()
  title: string;

  @IsString()
  content: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  sources?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}
