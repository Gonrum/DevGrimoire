import { IsString, IsOptional, IsArray, IsMongoId } from 'class-validator';

export class CreateResearchDto {
  @IsMongoId()
  @IsOptional()
  projectId?: string;

  @IsMongoId()
  @IsOptional()
  customerId?: string;

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
