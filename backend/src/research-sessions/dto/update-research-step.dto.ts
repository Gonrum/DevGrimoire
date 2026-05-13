import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { ResearchStepStatus } from '../schemas/research-step.schema';

export class UpdateResearchStepDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsEnum(ResearchStepStatus)
  @IsOptional()
  status?: ResearchStepStatus;

  @IsNumber()
  @IsOptional()
  order?: number;
}
