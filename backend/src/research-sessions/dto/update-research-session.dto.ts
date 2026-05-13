import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';
import { ResearchSessionStatus } from '../schemas/research-session.schema';

export class UpdateResearchSessionDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  projectIds?: string[];

  @IsEnum(ResearchSessionStatus)
  @IsOptional()
  status?: ResearchSessionStatus;
}
