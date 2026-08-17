import { IsString, IsOptional, IsEnum, IsArray, IsMongoId, IsNumber, IsBoolean, MinLength, Min, Max, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { RecurringAction, RecurringFrequency } from '../schemas/recurring-task.schema';

export class RecurringChatConfigDto {
  @IsString()
  @MinLength(1)
  prompt: string;

  @IsOptional()
  @IsString()
  systemPrompt?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedTools?: string[];

  @IsOptional()
  @IsString()
  agentRoleId?: string;

  @IsOptional()
  @IsNumber()
  @Min(5_000)
  @Max(600_000)
  timeoutMs?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  maxToolIterations?: number;

  @IsOptional()
  @IsEnum(['new', 'reuse'])
  sessionStrategy?: 'new' | 'reuse';
}

export class CreateRecurringTaskDto {
  @IsOptional()
  @IsMongoId()
  projectId?: string;

  @IsOptional()
  @IsMongoId()
  customerId?: string;

  @IsString()
  title: string;

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

  @IsEnum(RecurringFrequency)
  frequency: RecurringFrequency;

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

  @IsOptional()
  @IsMongoId()
  createdByUserId?: string;
}
