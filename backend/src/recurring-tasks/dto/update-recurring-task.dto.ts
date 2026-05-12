import { IsString, IsOptional, IsEnum, IsArray, IsMongoId, IsNumber, IsBoolean, Min, Max, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { RecurringAction, RecurringFrequency } from '../schemas/recurring-task.schema';
import { RecurringChatConfigDto } from './create-recurring-task.dto';

export class UpdateRecurringTaskDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(['low', 'medium', 'high', 'critical'])
  priority?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsMongoId()
  milestoneId?: string;

  @IsOptional()
  @IsString()
  repoLabel?: string;

  @IsOptional()
  @IsEnum(RecurringFrequency)
  frequency?: RecurringFrequency;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(31)
  dayOfMonth?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(12)
  month?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(23)
  hour?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  maxCatchUp?: number;

  @IsOptional()
  @IsEnum(RecurringAction)
  action?: RecurringAction;

  @IsOptional()
  @ValidateNested()
  @Type(() => RecurringChatConfigDto)
  chat?: RecurringChatConfigDto;
}
