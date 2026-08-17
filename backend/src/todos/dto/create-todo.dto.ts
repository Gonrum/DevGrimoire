import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsArray,
  IsMongoId,
  ValidateIf,
  IsBoolean,
  ValidateNested,
} from 'class-validator';
import { isRecord } from '../../common/narrow';
import { Type } from 'class-transformer';
import { TodoStatus, TodoPriority } from '../schemas/todo.schema';

export class AcceptanceCriterionDto {
  @IsString()
  @IsNotEmpty()
  text: string;

  @IsBoolean()
  @IsOptional()
  done?: boolean;
}

export class CreateTodoDto {
  @ValidateIf((o) => !(isRecord(o) && o.customerId))
  @IsMongoId()
  projectId?: string;

  @ValidateIf((o) => !(isRecord(o) && o.projectId))
  @IsMongoId()
  customerId?: string;

  @IsString()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsEnum(TodoStatus)
  @IsOptional()
  status?: TodoStatus;

  @IsEnum(TodoPriority)
  @IsOptional()
  priority?: TodoPriority;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @IsMongoId()
  @IsOptional()
  milestoneId?: string;

  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  blockedBy?: string[];

  @IsString()
  @IsOptional()
  repoLabel?: string;

  @IsString()
  @IsOptional()
  userStories?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AcceptanceCriterionDto)
  @IsOptional()
  acceptanceCriteria?: AcceptanceCriterionDto[];

  @IsString()
  @IsOptional()
  outOfScope?: string;

  @IsString()
  @IsOptional()
  edgeCases?: string;

  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  openQuestions?: string[];
}
