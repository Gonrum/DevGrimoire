import { IsString, IsOptional, IsEnum, IsMongoId, IsDateString } from 'class-validator';
import { MilestoneStatus } from '../schemas/milestone.schema';

export class CreateMilestoneDto {
  @IsMongoId()
  projectId: string;

  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsEnum(MilestoneStatus)
  @IsOptional()
  status?: MilestoneStatus;

  @IsDateString()
  @IsOptional()
  dueDate?: string;
}
