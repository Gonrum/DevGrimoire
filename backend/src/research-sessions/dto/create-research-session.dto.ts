import { IsArray, IsOptional, IsString } from 'class-validator';

export class CreateResearchSessionDto {
  @IsString()
  title: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  projectIds?: string[];
}
