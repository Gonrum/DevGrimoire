import { IsString, IsOptional, IsEnum, IsDateString, IsBoolean } from 'class-validator';
import { MilestoneStatus } from '../schemas/milestone.schema';

export class UpdateMilestoneDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsEnum(MilestoneStatus)
  @IsOptional()
  status?: MilestoneStatus;

  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @IsBoolean()
  @IsOptional()
  archived?: boolean;
}
